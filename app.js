/**
 * ============================================================================
 * CHINESE LEARNING HUB - FRONTEND APPLICATION CORE (app.js)
 * Architecture: Clean Namespace Modular Client
 * Features: GAS Bridge, In-Page Pinyin IME, SM-2 Spaced Repetition, Canvas Overlay, Analytics
 * ============================================================================
 */

window.App = (function() {
  'use strict';

  // ==========================================
  // 1. CONFIGURATION & STATE
  // ==========================================
  const CONFIG = {
    // THAY THẾ URL NÀY BẰNG WEB APP DEPLOYMENT URL TỪ GOOGLE APPS SCRIPT
    API_URL: "https://script.google.com/macros/s/AKfycbyDD9DjMYFx9YiCRTmCpkSQvlz1-OgMR703Oa1dXSlfjAePJw0F3htejYnD3ZG8yX0W5g/exec",
    STORAGE_KEYS: {
      TOKEN: "clh_auth_token",
      USER: "clh_user_data",
      IME_MODE: "clh_ime_mode"
    }
  };

  const STATE = {
    token: localStorage.getItem(CONFIG.STORAGE_KEYS.TOKEN) || null,
    user: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.USER) || "null"),
    currentView: "dashboard",
    imeMode: localStorage.getItem(CONFIG.STORAGE_KEYS.IME_MODE) || "VI", // "VI" | "ZH"
    activeCourse: null,
    cachedFlashcards: [],
    currentCardIndex: 0
  };

  // ==========================================
  // 2. RESILIENT API BRIDGE (JSON over POST)
  // ==========================================
  const API = {
    async call(action, payload = {}) {
      if (!CONFIG.API_URL || CONFIG.API_URL.includes("EXAMPLE_URL")) {
        console.warn("[API] Chưa thiết lập CONFIG.API_URL thật. Vui lòng cấu hình URL deployment từ Google Apps Script.");
      }

      const requestBody = {
        action: action,
        token: STATE.token,
        payload: payload,
        requestId: "REQ-" + Math.random().toString(36).substring(2, 9)
      };

      try {
        // Gửi qua text/plain để tránh CORS preflight phức tạp trên Google Apps Script Web App
        const response = await fetch(CONFIG.API_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          throw new Error(`Lỗi kết nối máy chủ (${response.status})`);
        }

        const data = await response.json();
        if (!data.success) {
          if (data.errorCode === "UNAUTHORIZED") {
            Auth.logout();
          }
          throw new Error(data.message || "Xử lý thất bại từ backend");
        }

        return data.data;
      } catch (err) {
        console.error(`[API Error] ${action}:`, err);
        UI.toast(err.message, "error");
        throw err;
      }
    }
  };

  // ==========================================
  // 3. AUTHENTICATION MODULE
  // ==========================================
  const Auth = {
    init() {
      const form = document.getElementById("login-form");
      if (form) {
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const email = document.getElementById("login-email").value.trim();
          const password = document.getElementById("login-password").value;
          const btn = document.getElementById("login-submit-btn");

          try {
            btn.disabled = true;
            btn.innerText = "Đang xác thực...";
            const res = await API.call("auth.login", { email, password });
            
            STATE.token = res.token;
            STATE.user = res.user;
            localStorage.setItem(CONFIG.STORAGE_KEYS.TOKEN, res.token);
            localStorage.setItem(CONFIG.STORAGE_KEYS.USER, JSON.stringify(res.user));

            UI.toast("Đăng nhập thành công!", "success");
            this.applyAuthState();
          } catch (err) {
            // Toast đã bắn trong API.call
          } finally {
            btn.disabled = false;
            btn.innerText = "Đăng nhập hệ thống";
          }
        });
      }

      const logoutBtn = document.getElementById("btn-logout");
      if (logoutBtn) {
        logoutBtn.addEventListener("click", () => this.logout());
      }

      this.applyAuthState();
    },

    applyAuthState() {
      const loginView = document.getElementById("login-view");
      const appContainer = document.getElementById("app-container");

      if (STATE.token && STATE.user) {
        loginView.style.display = "none";
        appContainer.style.display = "flex";

        document.getElementById("sidebar-user-name").innerText = STATE.user.fullName;
        document.getElementById("sidebar-user-role").innerText = STATE.user.role;
        document.getElementById("sidebar-user-avatar").src = STATE.user.avatar || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100";

        Router.navigate("dashboard");
      } else {
        loginView.style.display = "flex";
        appContainer.style.display = "none";
      }
    },

    logout() {
      if (STATE.token) {
        API.call("auth.logout", {}).catch(() => {});
      }
      STATE.token = null;
      STATE.user = null;
      localStorage.removeItem(CONFIG.STORAGE_KEYS.TOKEN);
      localStorage.removeItem(CONFIG.STORAGE_KEYS.USER);
      this.applyAuthState();
      UI.toast("Đã đăng xuất khỏi hệ thống.", "info");
    }
  };

  // ==========================================
  // 4. BUILT-IN CHINESE PINYIN IME ENGINE
  // ==========================================
  const PinyinEngine = {
    // Bảng dữ liệu ánh xạ âm Pinyin sang Chữ Hán tần suất cao (HSK 1-4)
    DICTIONARY_MAP: {
      "ni": ["你", "呢", "拟", "泥"],
      "hao": ["好", "号", "毫", "耗"],
      "nihao": ["你好"],
      "xue": ["学", "雪", "血"],
      "xi": ["习", "西", "系", "洗", "细"],
      "xuexi": ["学习"],
      "lao": ["老", "劳", "落"],
      "shi": ["是", "师", "时", "十", "事", "市", "识"],
      "laoshi": ["老师"],
      "xue": ["学"],
      "sheng": ["生", "声", "升"],
      "xuesheng": ["学生"],
      "zhong": ["中", "重", "钟", "种"],
      "guo": ["国", "过", "果"],
      "zhongguo": ["中国"],
      "xie": ["谢", "写", "些"],
      "xiexie": ["谢谢"],
      "zai": ["在", "再"],
      "jian": ["见", "件", "间", "简"],
      "zaijian": ["再见"],
      "wo": ["我", "握", "窝"],
      "ta": ["他", "她", "它"],
      "men": ["们", "门"],
      "women": ["我们"],
      "tamen": ["他们", "她们"],
      "shen": ["什", "身", "深", "神"],
      "me": ["么"],
      "shenme": ["什么"],
      "zen": ["怎"],
      "zenme": ["怎么"],
      "shui": ["谁", "水"],
      "ming": ["名", "明"],
      "zi": ["字", "子", "自"],
      "mingzi": ["名字"],
      "chi": ["吃", "迟"],
      "fan": ["饭", "反", "繁"],
      "chifan": ["吃饭"],
      "he": ["喝", "和", "河"],
      "cha": ["茶", "查", "差"],
      "hecha": ["喝茶"],
      "dian": ["点", "店", "电"],
      "qian": ["钱", "前", "千"],
      "duoshao": ["多少"],
      "duoshaoqian": ["多少钱"],
      "piao": ["票", "漂"],
      "liang": ["亮", "两", "量"],
      "piaoliang": ["漂亮"]
    },

    activeInput: null,
    currentBuffer: "",
    candidateList: [],
    selectedCandidateIdx: 0,

    init() {
      const viBtn = document.getElementById("btn-ime-vi");
      const zhBtn = document.getElementById("btn-ime-zh");
      const popover = document.getElementById("pinyin-ime-popover");

      const setMode = (mode) => {
        STATE.imeMode = mode;
        localStorage.setItem(CONFIG.STORAGE_KEYS.IME_MODE, mode);
        if (mode === "ZH") {
          zhBtn.classList.add("active");
          viBtn.classList.remove("active");
          UI.toast("Đã kích hoạt Bộ gõ 中文 Pinyin", "info");
        } else {
          viBtn.classList.add("active");
          zhBtn.classList.remove("active");
          this.closePopover();
          UI.toast("Đã chuyển về Bộ gõ Tiếng Việt", "info");
        }
      };

      viBtn.addEventListener("click", () => setMode("VI"));
      zhBtn.addEventListener("click", () => setMode("ZH"));

      // Ủy quyền sự kiện gõ trên toàn trang cho các input có class .pinyin-enabled
      document.addEventListener("keydown", (e) => this.handleKeyDown(e));
    },

    handleKeyDown(e) {
      if (STATE.imeMode !== "ZH") return;
      const target = e.target;
      if (!target || (!target.classList.contains("pinyin-enabled") && target.tagName !== "TEXTAREA" && target.tagName !== "INPUT")) {
        return;
      }
      this.activeInput = target;

      // Xử lý khi popup IME đang mở
      if (this.currentBuffer.length > 0) {
        if (e.key >= '1' && e.key <= '9') {
          const index = parseInt(e.key) - 1;
          if (index < this.candidateList.length) {
            e.preventDefault();
            this.commitCandidate(this.candidateList[index]);
            return;
          }
        }
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          const selected = this.candidateList[this.selectedCandidateIdx] || this.currentBuffer;
          this.commitCandidate(selected);
          return;
        }
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          this.selectedCandidateIdx = (this.selectedCandidateIdx + 1) % this.candidateList.length;
          this.renderPopover();
          return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          this.selectedCandidateIdx = (this.selectedCandidateIdx - 1 + this.candidateList.length) % this.candidateList.length;
          this.renderPopover();
          return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          this.currentBuffer = this.currentBuffer.slice(0, -1);
          if (this.currentBuffer.length === 0) {
            this.closePopover();
          } else {
            this.updateCandidates();
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.closePopover();
          return;
        }
      }

      // Nhận diện ký tự alphabet tiếng Anh (pinyin)
      if (/^[a-zA-Z]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        this.currentBuffer += e.key.toLowerCase();
        this.updateCandidates();
      }
    },

    updateCandidates() {
      const candidates = this.DICTIONARY_MAP[this.currentBuffer] || [];
      if (candidates.length === 0) {
        // Fallback: tìm ký tự lẻ
        this.candidateList = [this.currentBuffer];
      } else {
        this.candidateList = candidates;
      }
      this.selectedCandidateIdx = 0;
      this.renderPopover();
    },

    renderPopover() {
      const popover = document.getElementById("pinyin-ime-popover");
      const syllableText = document.getElementById("ime-syllable-text");
      const candidatesList = document.getElementById("ime-candidates-list");

      if (!this.activeInput) return;

      const rect = this.activeInput.getBoundingClientRect();
      popover.style.display = "block";
      popover.style.top = (window.scrollY + rect.bottom + 4) + "px";
      popover.style.left = (window.scrollX + rect.left + 10) + "px";

      syllableText.innerText = `Pinyin: ${this.currentBuffer}`;
      candidatesList.innerHTML = this.candidateList.map((cand, idx) => `
        <span class="ime-candidate-item ${idx === this.selectedCandidateIdx ? 'selected' : ''}" data-idx="${idx}">
          ${idx + 1}.${cand}
        </span>
      `).join('');

      // Click trực tiếp vào candidate
      candidatesList.querySelectorAll(".ime-candidate-item").forEach(item => {
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const idx = parseInt(item.getAttribute("data-idx"));
          this.commitCandidate(this.candidateList[idx]);
        });
      });
    },

    commitCandidate(text) {
      if (!this.activeInput) return;
      const el = this.activeInput;
      const start = el.selectionStart || 0;
      const end = el.selectionEnd || 0;
      const currentVal = el.value;

      el.value = currentVal.substring(0, start) + text + currentVal.substring(end);
      el.selectionStart = el.selectionEnd = start + text.length;

      // Kích hoạt event input để các handler phản ứng
      el.dispatchEvent(new Event('input', { bubbles: true }));
      this.closePopover();
    },

    closePopover() {
      this.currentBuffer = "";
      this.candidateList = [];
      const popover = document.getElementById("pinyin-ime-popover");
      if (popover) popover.style.display = "none";
    }
  };

  // ==========================================
  // 5. VIEW ROUTER & NAVIGATION
  // ==========================================
  const Router = {
    init() {
      document.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", (e) => {
          e.preventDefault();
          const viewName = item.getAttribute("data-view");
          this.navigate(viewName);
        });
      });
    },

    navigate(viewName) {
      STATE.currentView = viewName;
      document.querySelectorAll(".nav-item").forEach(item => {
        if (item.getAttribute("data-view") === viewName) {
          item.classList.add("active");
        } else {
          item.classList.remove("active");
        }
      });

      document.querySelectorAll(".content-view-pane").forEach(pane => {
        pane.style.display = "none";
      });

      const activePane = document.getElementById(`view-${viewName}`);
      if (activePane) {
        activePane.style.display = "block";
      }

      const titles = {
        dashboard: "Bàn làm việc",
        courses: "Khóa học & Lịch trình 1:1",
        assignments: "Quản lý Bài tập & Nộp bài",
        "error-notebook": "Sổ lỗi sai (错题本)",
        "learning-journal": "Nhật ký phản tư học tập",
        dictionary: "Tra cứu Từ điển Trung - Việt",
        vocabulary: "Sổ từ vựng cá nhân",
        flashcards: "Học từ vựng Flashcards SM-2",
        reports: "Báo cáo Phân tích & Đánh giá"
      };

      document.getElementById("page-current-title").innerText = titles[viewName] || "Learning Hub";
      lucide.createIcons();

      // Trigger lazy load view data
      this.loadViewData(viewName);
    },

    async loadViewData(viewName) {
      switch (viewName) {
        case "dashboard":
          Dashboard.load();
          break;
        case "courses":
          Courses.load();
          break;
        case "assignments":
          Assignments.load();
          break;
        case "error-notebook":
          ErrorNotebook.load();
          break;
        case "learning-journal":
          Journal.load();
          break;
        case "vocabulary":
          Vocabulary.load();
          break;
        case "flashcards":
          Flashcard.load();
          break;
        case "reports":
          Reports.load();
          break;
      }
    }
  };

  // ==========================================
  // 6. MODULE: DASHBOARD
  // ==========================================
  const Dashboard = {
    async load() {
      try {
        if (STATE.user.role === "STUDENT") {
          const data = await API.call("dashboard.getStudent");
          
          document.getElementById("stat-completed-lessons").innerText = `${data.totalCompletedLessons}/${data.totalPlannedLessons}`;
          document.getElementById("stat-pending-tasks").innerText = data.pendingAssignments ? data.pendingAssignments.length : 0;
          document.getElementById("stat-due-flashcards").innerText = data.dueFlashcardsCount || 0;

          const meetBtn = document.getElementById("btn-join-meet");
          if (data.upcomingLesson && data.upcomingLesson.meet_url) {
            meetBtn.href = data.upcomingLesson.meet_url;
            meetBtn.style.display = "inline-flex";
            document.getElementById("dash-upcoming-lesson-info").innerHTML = `
              <strong>${data.upcomingLesson.lesson_name}</strong><br>
              <span style="color:var(--text-muted);">Thời gian: ${data.upcomingLesson.lesson_date} | ${data.upcomingLesson.start_time} - ${data.upcomingLesson.end_time}</span><br>
              <p style="margin-top:6px;">Chủ đề: <em>${data.upcomingLesson.topic}</em></p>
            `;
          } else {
            meetBtn.style.display = "none";
            document.getElementById("dash-upcoming-lesson-info").innerText = "Chưa có lịch buổi học tiếp theo.";
          }

          const tbody = document.getElementById("dash-submissions-tbody");
          if (data.recentSubmissions && data.recentSubmissions.length > 0) {
            tbody.innerHTML = data.recentSubmissions.map(item => `
              <tr>
                <td><strong>${item.assignment.title}</strong></td>
                <td>Lần ${item.submission.attempt_number}</td>
                <td>${new Date(item.submission.submitted_at).toLocaleDateString("vi-VN")}</td>
                <td><span class="user-role-tag">${item.submission.status}</span></td>
                <td><strong>${item.grade ? item.grade.total_score + ' / ' + item.grade.max_score : 'Chờ chấm'}</strong></td>
              </tr>
            `).join('');
          } else {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">Chưa có bài nộp nào.</td></tr>`;
          }

        } else {
          // Teacher Dashboard
          const data = await API.call("dashboard.getTeacher");
          document.getElementById("stat-completed-lessons").innerText = data.activeCoursesCount + " Lớp";
          document.getElementById("stat-pending-tasks").innerText = data.pendingGradingCount;
          document.getElementById("stat-due-flashcards").innerText = data.totalStudentsCount + " Học sinh";

          document.getElementById("btn-join-meet").style.display = "none";
          document.getElementById("dash-upcoming-lesson-info").innerHTML = data.upcomingLessons && data.upcomingLessons.length > 0
            ? data.upcomingLessons.map(l => `<div>• <strong>${l.lesson_name}</strong> (${l.lesson_date})</div>`).join('')
            : "Không có buổi học sắp tới.";

          const tbody = document.getElementById("dash-submissions-tbody");
          if (data.waitingGradingList && data.waitingGradingList.length > 0) {
            tbody.innerHTML = data.waitingGradingList.map(item => `
              <tr>
                <td><strong>${item.assignmentTitle}</strong></td>
                <td>Lần ${item.attemptNumber}</td>
                <td>${new Date(item.submittedAt).toLocaleDateString("vi-VN")}</td>
                <td><span style="color:var(--warning); font-weight:600;">Cần chấm bài</span></td>
                <td><button class="btn btn-outline btn-sm" onclick="App.Grading.openGradeModal('${item.submissionId}')">Chấm bài</button></td>
              </tr>
            `).join('');
          } else {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">Không có bài tập nào cần chấm.</td></tr>`;
          }
        }
        lucide.createIcons();
      } catch (e) {
        console.error(e);
      }
    }
  };

  // ==========================================
  // 7. MODULE: COURSES & LESSONS
  // ==========================================
  const Courses = {
    async load() {
      const container = document.getElementById("courses-lessons-container");
      container.innerHTML = "<p>Đang tải danh sách khóa học...</p>";
      try {
        const courses = await API.call("course.list");
        if (courses.length === 0) {
          container.innerHTML = "<div class='editorial-card'>Chưa có khóa học nào được chỉ định.</div>";
          return;
        }
        STATE.activeCourse = courses[0];

        const lessons = await API.call("lesson.list", { courseId: STATE.activeCourse.course_id });
        container.innerHTML = `
          <div class="editorial-card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
              <div>
                <h3 style="font-size:16px; font-weight:700;">${STATE.activeCourse.course_name}</h3>
                <span class="user-role-tag">${STATE.activeCourse.hsk_level}</span>
                <span style="font-size:12px; color:var(--text-muted); margin-left:8px;">Bắt đầu: ${STATE.activeCourse.start_date}</span>
              </div>
            </div>
            
            <div class="hub-table-wrapper">
              <table class="hub-table">
                <thead>
                  <tr>
                    <th>Buổi</th>
                    <th>Chủ đề & Mục tiêu</th>
                    <th>Thời gian</th>
                    <th>Trạng thái</th>
                    <th>Tác vụ</th>
                  </tr>
                </thead>
                <tbody>
                  ${lessons.map((les, idx) => `
                    <tr>
                      <td><strong>#${idx + 1}</strong></td>
                      <td>
                        <strong>${les.lesson_name}</strong><br>
                        <span style="font-size:12px; color:var(--text-muted);">${les.topic}</span>
                      </td>
                      <td>${les.lesson_date} (${les.start_time})</td>
                      <td><span class="user-role-tag">${les.status}</span></td>
                      <td>
                        ${les.meet_url ? `<a href="${les.meet_url}" target="_blank" class="btn btn-outline btn-sm">Vào lớp</a>` : ''}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `;
      } catch (e) {
        container.innerHTML = "<p style='color:var(--danger);'>Không thể tải thông tin khóa học.</p>";
      }
    }
  };

  // ==========================================
  // 8. MODULE: ASSIGNMENTS & SUBMISSION
  // ==========================================
  const Assignments = {
    async load() {
      const container = document.getElementById("assignments-list-container");
      container.innerHTML = "<p>Đang nạp bài tập...</p>";
      try {
        if (!STATE.activeCourse) {
          const courses = await API.call("course.list");
          if (courses.length > 0) STATE.activeCourse = courses[0];
        }

        const assList = await API.call("assignment.list", { courseId: STATE.activeCourse ? STATE.activeCourse.course_id : "" });
        if (assList.length === 0) {
          container.innerHTML = "<div class='editorial-card'>Không có bài tập nào.</div>";
          return;
        }

        container.innerHTML = assList.map(a => `
          <div class="editorial-card">
            <div class="card-header-clean">
              <div>
                <span class="user-role-tag">${a.assignment_type}</span>
                <h3 style="font-size:16px; font-weight:700; margin-top:4px;">${a.title}</h3>
                <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">
                  Hạn chót: <strong>${a.deadline}</strong> | Điểm tối đa: ${a.max_score}
                </div>
              </div>
              <div>
                ${STATE.user.role === "STUDENT" 
                  ? `<button class="btn btn-primary btn-sm" onclick="App.Assignments.openSubmitModal('${a.assignment_id}', '${a.title.replace(/'/g, "\\'")}')">Làm & Nộp bài</button>`
                  : `<button class="btn btn-outline btn-sm">Xem danh sách nộp</button>`
                }
              </div>
            </div>
            <div style="font-size:13px; color:var(--text-main); margin-bottom:8px;">${a.description}</div>
            <div style="font-size:12px; background:#FAF9F6; padding:10px; border-radius:var(--radius-sm); border-left:3px solid var(--primary);">
              <strong>Hướng dẫn của Giáo viên:</strong> ${a.instructions}
            </div>
          </div>
        `).join('');
      } catch (e) {
        container.innerHTML = "<p style='color:var(--danger);'>Lỗi nạp bài tập.</p>";
      }
    },

    openSubmitModal(assignmentId, title) {
      document.getElementById("sub-assignment-id").value = assignmentId;
      document.getElementById("sub-modal-title").innerText = `Nộp bài: ${title}`;
      document.getElementById("sub-text-content").value = "";
      document.getElementById("sub-file-input").value = "";
      UI.openModal("submission-modal");
    },

    initSubmitForm() {
      const form = document.getElementById("submission-form");
      if (!form) return;
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const assId = document.getElementById("sub-assignment-id").value;
        const text = document.getElementById("sub-text-content").value;
        const fileInput = document.getElementById("sub-file-input");
        const submitBtn = document.getElementById("btn-submit-work");

        try {
          submitBtn.disabled = true;
          submitBtn.innerText = "Đang tải bài nộp lên Google Drive...";

          let fileIds = [];
          if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            const base64 = await this.fileToBase64(file);
            const uploadRes = await API.call("submission.uploadFile", {
              fileName: file.name,
              mimeType: file.type,
              base64Content: base64
            });
            fileIds.push(uploadRes.file_id);
          }

          await API.call("submission.create", {
            assignmentId: assId,
            textContent: text,
            submissionType: fileIds.length > 0 ? "Mixed" : "Text",
            fileIds: fileIds
          });

          UI.toast("Nộp bài thành công!", "success");
          UI.closeModal("submission-modal");
          Router.loadViewData("dashboard");
        } catch (err) {
          // Toast handled
        } finally {
          submitBtn.disabled = false;
          submitBtn.innerText = "Nộp bài chính thức";
        }
      });
    },

    fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = error => reject(error);
      });
    }
  };

  // ==========================================
  // 9. MODULE: GRADING & ANNOTATION (TEACHER)
  // ==========================================
  const Grading = {
    init() {
      const form = document.getElementById("grading-form");
      if (!form) return;
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const subId = document.getElementById("grade-sub-id").value;
        const totalScore = document.getElementById("grade-total-score").value;
        const grammar = document.getElementById("grade-rubric-grammar").value;
        const feedback = document.getElementById("grade-feedback-text").value;

        const errWrong = document.getElementById("grade-err-wrong").value.trim();
        const errCorrect = document.getElementById("grade-err-correct").value.trim();
        const errExp = document.getElementById("grade-err-exp").value.trim();

        const errorEntries = [];
        if (errWrong && errCorrect) {
          errorEntries.push({
            wrongText: errWrong,
            correctText: errCorrect,
            explanation: errExp,
            category: "Grammar",
            priority: "HIGH"
          });
        }

        try {
          await API.call("grading.save", {
            submissionId: subId,
            totalScore: Number(totalScore),
            maxScore: 100,
            rubricJson: { Grammar: Number(grammar) },
            feedbackText: feedback,
            errorEntries: errorEntries
          });

          UI.toast("Đã lưu kết quả chấm và đồng bộ Sổ lỗi!", "success");
          UI.closeModal("grading-modal");
          Router.loadViewData("dashboard");
        } catch (err) {
          // Toast handled
        }
      });
    },

    async openGradeModal(submissionId) {
      document.getElementById("grade-sub-id").value = submissionId;
      const detail = await API.call("submission.getDetail", { submissionId });
      
      const summaryBox = document.getElementById("grading-submission-summary");
      summaryBox.innerHTML = `
        <strong>Bài làm của học sinh (Lần ${detail.submission.attempt_number}):</strong>
        <div style="margin:8px 0; padding:8px; background:#fff; border:1px solid var(--border-color);">${detail.submission.text_content || 'Không có văn bản.'}</div>
        ${detail.files.length > 0 ? `<div>File đính kèm: <a href="${detail.files[0].file_url}" target="_blank" class="btn btn-outline btn-sm">Xem file Drive</a></div>` : ''}
      `;

      UI.openModal("grading-modal");
    }
  };

  // ==========================================
  // 10. MODULE: FLASHCARDS (SPACED REPETITION SM-2)
  // ==========================================
  const Flashcard = {
    isFlipped: false,

    async load() {
      const selector = document.getElementById("deck-selector-wrap");
      try {
        const decks = await API.call("flashcard.getDecks");
        if (decks.length === 0) {
          document.getElementById("fc-hanzi").innerText = "Chưa có bộ thẻ";
          return;
        }

        selector.innerHTML = `
          <select id="flashcard-deck-select" style="padding:6px 12px; border:1px solid var(--border-color); border-radius:var(--radius-sm); font-size:13px;">
            ${decks.map(d => `<option value="${d.deck_id}">${d.title} (${d.hsk_level})</option>`).join('')}
          </select>
        `;

        document.getElementById("flashcard-deck-select").addEventListener("change", (e) => {
          this.loadDueCards(e.target.value);
        });

        await this.loadDueCards(decks[0].deck_id);
      } catch (e) {
        console.error(e);
      }
    },

    async loadDueCards(deckId) {
      try {
        const dueList = await API.call("flashcard.getDueCards", { deckId });
        STATE.cachedFlashcards = dueList.map(item => item.card);
        STATE.currentCardIndex = 0;
        this.renderCurrentCard();
      } catch (e) {
        console.error(e);
      }
    },

    renderCurrentCard() {
      this.isFlipped = false;
      const frontPane = document.getElementById("fc-front-pane");
      const backPane = document.getElementById("fc-back-pane");
      const controls = document.getElementById("fc-action-controls");

      frontPane.style.display = "block";
      backPane.style.display = "none";
      controls.style.display = "none";

      if (STATE.cachedFlashcards.length === 0 || STATE.currentCardIndex >= STATE.cachedFlashcards.length) {
        document.getElementById("fc-hanzi").innerText = "Đã hoàn thành ôn tập!";
        frontPane.querySelector("p").innerText = "Không còn thẻ nào cần ôn hôm nay.";
        return;
      }

      const card = STATE.cachedFlashcards[STATE.currentCardIndex];
      document.getElementById("fc-hanzi").innerText = card.front_text;
      document.getElementById("fc-pinyin").innerText = card.back_pinyin;
      document.getElementById("fc-meaning").innerText = card.back_meaning;
      document.getElementById("fc-example").innerText = card.example_sentence ? `Ví dụ: ${card.example_sentence}` : "";
    },

    flip() {
      if (STATE.cachedFlashcards.length === 0 || STATE.currentCardIndex >= STATE.cachedFlashcards.length) return;
      this.isFlipped = !this.isFlipped;
      document.getElementById("fc-front-pane").style.display = this.isFlipped ? "none" : "block";
      document.getElementById("fc-back-pane").style.display = this.isFlipped ? "block" : "none";
      document.getElementById("fc-action-controls").style.display = this.isFlipped ? "flex" : "none";
    },

    async review(quality) {
      const card = STATE.cachedFlashcards[STATE.currentCardIndex];
      if (!card) return;

      try {
        await API.call("flashcard.submitReview", {
          cardId: card.card_id,
          quality: quality
        });
        STATE.currentCardIndex++;
        this.renderCurrentCard();
      } catch (err) {
        // Handled
      }
    },

    initEvents() {
      const box = document.getElementById("flashcard-box");
      if (box) {
        box.addEventListener("click", () => this.flip());
      }
      document.addEventListener("keydown", (e) => {
        if (STATE.currentView === "flashcards" && e.code === "Space" && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
          e.preventDefault();
          this.flip();
        }
      });
    }
  };

  // ==========================================
  // 11. MODULE: DICTIONARY & VOCABULARY
  // ==========================================
  const Dictionary = {
    init() {
      const btn = document.getElementById("btn-dict-search");
      const input = document.getElementById("dict-search-input");
      if (!btn || !input) return;

      const triggerSearch = async () => {
        const query = input.value.trim();
        if (!query) return;
        const resBox = document.getElementById("dict-search-results");
        resBox.innerHTML = "<p>Đang tra cứu từ điển...</p>";

        try {
          const results = await API.call("dictionary.search", { query });
          if (results.length === 0) {
            resBox.innerHTML = "<p style='color:var(--text-muted);'>Không tìm thấy mục từ phù hợp.</p>";
            return;
          }

          resBox.innerHTML = results.map(item => `
            <div style="padding:16px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;">
              <div>
                <span class="zh-text" style="font-size:24px; font-weight:700; color:var(--text-main);">${item.simplified}</span>
                <span style="font-size:14px; color:var(--primary); margin-left:10px;">${item.pinyin}</span>
                <span class="user-role-tag" style="margin-left:8px;">${item.hsk_level}</span>
                <div style="font-size:14px; font-weight:600; margin-top:4px;">${item.meaning_vi}</div>
                ${item.example_zh ? `<div style="font-size:12px; color:var(--text-muted); margin-top:4px;">VD: ${item.example_zh} — <em>${item.example_vi}</em></div>` : ''}
              </div>
              <button class="btn btn-outline btn-sm" onclick="App.Vocabulary.addFromDict('${item.simplified}', '${item.pinyin}', '${item.meaning_vi}')">
                <i data-lucide="bookmark-plus"></i> Lưu vào Sổ từ
              </button>
            </div>
          `).join('');
          lucide.createIcons();
        } catch (e) {
          resBox.innerHTML = "<p style='color:var(--danger);'>Lỗi tra từ điển.</p>";
        }
      };

      btn.addEventListener("click", triggerSearch);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !document.getElementById("pinyin-ime-popover").style.display.includes("block")) {
          triggerSearch();
        }
      });
    }
  };

  const Vocabulary = {
    async load() {
      const tbody = document.getElementById("vocab-table-tbody");
      tbody.innerHTML = "<tr><td colspan='6' style='text-align:center;'>Đang nạp sổ từ vựng...</td></tr>";
      try {
        const list = await API.call("vocabulary.list");
        if (list.length === 0) {
          tbody.innerHTML = "<tr><td colspan='6' style='text-align:center; color:var(--text-muted);'>Sổ từ vựng đang trống.</td></tr>";
          return;
        }

        tbody.innerHTML = list.map(item => {
          const w = item.wordData || {};
          return `
            <tr>
              <td><strong class="zh-text" style="font-size:18px;">${w.simplified || 'N/A'}</strong></td>
              <td style="color:var(--primary);">${w.pinyin || ''}</td>
              <td><strong>${w.vietnamese_meaning || ''}</strong></td>
              <td><span class="user-role-tag">${w.hsk_level || 'HSK 1'}</span></td>
              <td style="font-size:12px; color:var(--text-muted);">${w.example_zh || ''}</td>
              <td>
                <button class="btn btn-outline btn-sm" onclick="App.Vocabulary.toggleFavorite('${item.entryId}', ${!item.isFavorite})">
                  ${item.isFavorite ? '★ Đã thích' : '☆ Thích'}
                </button>
              </td>
            </tr>
          `;
        }).join('');
      } catch (e) {
        tbody.innerHTML = "<tr><td colspan='6' style='text-align:center; color:var(--danger);'>Lỗi nạp từ vựng.</td></tr>";
      }
    },

    async addFromDict(hanzi, pinyin, meaning) {
      try {
        await API.call("vocabulary.create", {
          simplified: hanzi,
          pinyin: pinyin,
          vietnameseMeaning: meaning,
          source: "DICTIONARY"
        });
        UI.toast(`Đã lưu "${hanzi}" vào sổ từ vựng!`, "success");
      } catch (e) {}
    },

    async toggleFavorite(entryId, isFav) {
      await API.call("vocabulary.toggleFavorite", { entryId, isFavorite: isFav });
      this.load();
    }
  };

  // ==========================================
  // 12. MODULE: ERROR NOTEBOOK & JOURNAL
  // ==========================================
  const ErrorNotebook = {
    async load() {
      const tbody = document.getElementById("error-notebook-tbody");
      tbody.innerHTML = "<tr><td colspan='5' style='text-align:center;'>Đang tải dữ liệu...</td></tr>";
      try {
        const errors = await API.call("errorNotebook.list");
        if (errors.length === 0) {
          tbody.innerHTML = "<tr><td colspan='5' style='text-align:center; color:var(--text-muted);'>Chưa có lỗi sai nào được ghi nhận. Rất tốt!</td></tr>";
          return;
        }

        tbody.innerHTML = errors.map(err => `
          <tr>
            <td style="color:var(--danger); font-weight:600;">${err.wrong_text}</td>
            <td style="color:var(--success); font-weight:600;">${err.correct_text}</td>
            <td style="font-size:12px;">${err.explanation}</td>
            <td><span class="user-role-tag">${err.category}</span></td>
            <td>
              <button class="btn btn-outline btn-sm" onclick="App.ErrorNotebook.toggle('${err.error_id}', ${err.is_resolved !== 'TRUE'})">
                ${err.is_resolved === 'TRUE' ? '✓ Đã khắc phục' : '○ Cần ôn lại'}
              </button>
            </td>
          </tr>
        `).join('');
      } catch (e) {
        tbody.innerHTML = "<tr><td colspan='5' style='text-align:center; color:var(--danger);'>Lỗi nạp Sổ lỗi.</td></tr>";
      }
    },

    async toggle(errorId, resolve) {
      await API.call("errorNotebook.toggleResolved", { errorId, isResolved: resolve });
      this.load();
    }
  };

  const Journal = {
    init() {
      const form = document.getElementById("journal-entry-form");
      if (!form) return;
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const learned = document.getElementById("journal-learned").value;
        const diff = document.getElementById("journal-difficulties").value;
        const rating = document.getElementById("journal-rating").value;

        try {
          await API.call("journal.create", {
            learnedToday: learned,
            difficulties: diff,
            rating: Number(rating)
          });
          UI.toast("Đã ghi lại nhật ký học tập!", "success");
          form.reset();
          this.load();
        } catch (e) {}
      });
    },

    async load() {
      const box = document.getElementById("journal-entries-history");
      try {
        const entries = await API.call("journal.list");
        if (entries.length === 0) {
          box.innerHTML = "";
          return;
        }

        box.innerHTML = `
          <h4 style="font-size:14px; font-weight:700; margin:20px 0 10px;">Lịch sử nhật ký phản tư</h4>
          ${entries.map(j => `
            <div class="editorial-card" style="margin-bottom:12px; padding:16px;">
              <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted); margin-bottom:6px;">
                <span>Ngày ghi: <strong>${j.entry_date}</strong></span>
                <span>Mức độ hiểu: ${'⭐'.repeat(Number(j.comprehension_rating))}</span>
              </div>
              <div style="font-size:13px; font-weight:600;">${j.learned_today}</div>
              ${j.difficulties ? `<div style="font-size:12px; color:var(--warning); margin-top:4px;">Khó khăn: ${j.difficulties}</div>` : ''}
              ${j.teacher_reply ? `<div style="margin-top:8px; padding:8px; background:#F0F6F4; border-radius:4px; font-size:12px; color:var(--jade-green);"><strong>Lão Sư phản hồi:</strong> ${j.teacher_reply}</div>` : ''}
            </div>
          `).join('')}
        `;
      } catch (e) {}
    }
  };

  // ==========================================
  // 13. MODULE: REPORTS & CHARTS
  // ==========================================
  const Reports = {
    radarChart: null,
    donutChart: null,

    async load() {
      try {
        const overview = await API.call("report.getOverview");
        const issues = await API.call("report.getAttentionIssues");

        // Attention list
        const issuesBox = document.getElementById("report-attention-list");
        if (issues.length === 0) {
          issuesBox.innerHTML = "<p style='color:var(--jade-green); font-size:13px;'>Học sinh nắm chắc toàn bộ kiến thức, không phát hiện lỗ hổng lớn.</p>";
        } else {
          issuesBox.innerHTML = issues.map(iss => `
            <div style="padding:10px 14px; background:#FBF0EE; border-left:4px solid var(--danger); border-radius:4px; margin-bottom:8px; font-size:13px;">
              <strong>[${iss.type}]</strong> Cần sửa: <span style="text-decoration:line-through; color:var(--danger);">${iss.wrongContent}</span> → <strong style="color:var(--success);">${iss.correctContent}</strong>
              <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">Ghi chú: ${iss.explanation}</div>
            </div>
          `).join('');
        }

        // Render Radar Chart for Skills
        const ctxRadar = document.getElementById("chart-skills-radar").getContext("2d");
        if (this.radarChart) this.radarChart.destroy();
        this.radarChart = new Chart(ctxRadar, {
          type: "radar",
          data: {
            labels: ["Ngữ pháp", "Từ vựng", "Phát âm", "Đọc hiểu", "Viết Hán tự"],
            datasets: [{
              label: "Mức độ thuần thục (%)",
              data: [80, 88, 75, 85, 78],
              backgroundColor: "rgba(200, 75, 56, 0.2)",
              borderColor: "#C84B38",
              pointBackgroundColor: "#C84B38"
            }]
          },
          options: {
            scales: { r: { min: 0, max: 100 } },
            plugins: { legend: { display: false } }
          }
        });

        // Render Donut Chart for Tasks
        const ctxDonut = document.getElementById("chart-completion-donut").getContext("2d");
        if (this.donutChart) this.donutChart.destroy();
        this.donutChart = new Chart(ctxDonut, {
          type: "doughnut",
          data: {
            labels: ["Đã hoàn thành", "Chưa hoàn thành"],
            datasets: [{
              data: [overview.submittedCount, Math.max(0, overview.totalAssignments - overview.submittedCount)],
              backgroundColor: ["#4F8A69", "#E9E7E0"]
            }]
          },
          options: {
            plugins: { legend: { position: "bottom" } }
          }
        });

      } catch (e) {
        console.error("Lỗi nạp báo cáo:", e);
      }
    }
  };

  // ==========================================
  // 14. UI HELPERS & NOTIFICATIONS
  // ==========================================
  const UI = {
    toast(message, type = "info") {
      const rack = document.getElementById("toast-rack");
      const pill = document.createElement("div");
      pill.className = `toast-pill ${type}`;
      pill.innerText = message;
      rack.appendChild(pill);
      setTimeout(() => {
        pill.style.opacity = "0";
        setTimeout(() => pill.remove(), 300);
      }, 3500);
    },

    openModal(modalId) {
      const modal = document.getElementById(modalId);
      if (modal) modal.classList.add("active");
    },

    closeModal(modalId) {
      const modal = document.getElementById(modalId);
      if (modal) modal.classList.remove("active");
    }
  };

  // ==========================================
  // 15. BOOTSTRAP INITIALIZATION
  // ==========================================
  function init() {
    Auth.init();
    PinyinEngine.init();
    Router.init();
    Assignments.initSubmitForm();
    Grading.init();
    Flashcard.initEvents();
    Dictionary.init();
    Journal.init();
  }

  // Public Interface
  return {
    init,
    UI,
    Router,
    Assignments,
    Grading,
    Flashcard,
    Vocabulary,
    ErrorNotebook
  };
})();

// Launch application on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  App.init();
});