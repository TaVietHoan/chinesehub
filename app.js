/**
 * ============================================================================
 * CHINESE LEARNING HUB - FRONTEND APPLICATION CORE (app.js)
 * Version: 2.1.0 (Imperial Modern Edition - Multi-Media & Dual Dictionary)
 * ============================================================================
 */

window.App = (function() {
  'use strict';

  // ==========================================
  // 1. CẤU HÌNH & TRẠNG THÁI HỆ THỐNG
  // ==========================================
  const CONFIG = {
    // URL Web App Google Apps Script của bạn (kết thúc bằng /exec)
    API_URL: "https://script.google.com/macros/s/AKfycbyDD9DjMYFx9YiCRTmCpkSQvlz1-OgMR703Oa1dXSlfjAePJw0F3htejYnD3ZG8yX0W5g/exec",
    STORAGE_KEYS: {
      TOKEN: "clh_auth_token",
      USER: "clh_user_data",
      IME_MODE: "clh_ime_mode"
    },
    INDEXED_DB: {
      NAME: "CLH_DictionaryDB_v2",
      VERSION: 1,
      STORE_NAME: "words"
    }
  };

  const STATE = {
    token: localStorage.getItem(CONFIG.STORAGE_KEYS.TOKEN) || null,
    user: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.USER) || "null"),
    currentView: "dashboard",
    imeMode: localStorage.getItem(CONFIG.STORAGE_KEYS.IME_MODE) || "ZH",
    dictMode: "ZH_VI", // "ZH_VI" (Trung -> Việt) hoặc "VI_ZH" (Việt -> Trung)
    activeCourse: null,
    cachedFlashcards: [],
    currentCardIndex: 0,
    dbInstance: null,
    dictionaryReady: false,
    pinyinIndexMap: new Map() // pinyin_clean -> [hanzi...]
  };

  // ==========================================
  // 2. HELPER: ĐỊNH DẠNG NGÀY GIỜ & XỬ LÝ DỮ LIỆU
  // ==========================================
  const Utils = {
    /**
     * Khắc phục triệt để lỗi hiển thị ngày ISO UTC
     * Trả về định dạng: DD/MM/YYYY
     */
    formatDateVN(dateStr) {
      if (!dateStr) return "Chưa cập nhật";
      try {
        const str = String(dateStr).trim();
        // Nếu là dạng chuỗi YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
          const parts = str.split("-");
          return `${parts[2]}/${parts[1]}/${parts[0]}`;
        }
        const d = new Date(str);
        if (isNaN(d.getTime())) return str;
        const day = String(d.getDate()).padStart(2, "0");
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
      } catch (_) {
        return String(dateStr);
      }
    },

    /**
     * Khắc phục triệt để lỗi Google Sheets epoch 1899-12-30T...
     * Trả về định dạng: HH:mm (VD: 19:30)
     */
    formatTimeVN(timeStr) {
      if (!timeStr) return "";
      try {
        const str = String(timeStr).trim();
        // Nếu là dạng HH:mm
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(str)) {
          const parts = str.split(":");
          return `${parts[0].padStart(2, "0")}:${parts[1]}`;
        }
        // Nếu là dạng ISO có chứa 1899 hoặc Date string
        const d = new Date(str);
        if (!isNaN(d.getTime())) {
          const hours = String(d.getHours()).padStart(2, "0");
          const mins = String(d.getMinutes()).padStart(2, "0");
          return `${hours}:${mins}`;
        }
        return str;
      } catch (_) {
        return String(timeStr);
      }
    },

    /**
     * Hiển thị ngày giờ kết hợp: DD/MM/YYYY HH:mm
     */
    formatDateTimeVN(isoStr) {
      if (!isoStr) return "";
      try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return isoStr;
        const day = String(d.getDate()).padStart(2, "0");
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const year = d.getFullYear();
        const hours = String(d.getHours()).padStart(2, "0");
        const mins = String(d.getMinutes()).padStart(2, "0");
        return `${day}/${month}/${year} ${hours}:${mins}`;
      } catch (_) {
        return isoStr;
      }
    },

    fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = error => reject(error);
      });
    },

    escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
  };

  // ==========================================
  // 3. API BRIDGE (JSON over POST)
  // ==========================================
  const API = {
    async call(action, payload = {}) {
      if (!CONFIG.API_URL || CONFIG.API_URL.includes("EXAMPLE_URL")) {
        console.warn("[API] Chưa thiết lập CONFIG.API_URL chuẩn.");
      }

      const requestBody = {
        action: action,
        token: STATE.token,
        payload: payload,
        requestId: "REQ-" + Math.random().toString(36).substring(2, 9)
      };

      try {
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
  // 4. ULTRA-FAST INDEXED-DB DICTIONARY (2 CHIỀU RIÊNG BIỆT)
  // ==========================================
  const LocalDictionary = {
    async init() {
      try {
        await this.openDB();
        const count = await this.countWords();
        if (count === 0) {
          console.log("[LocalDictionary] Đang nạp dữ liệu từ điển Hán ngữ...");
          await this.syncFromBackend();
        } else {
          console.log(`[LocalDictionary] Đã nạp ${count} từ vựng từ IndexedDB.`);
          await this.buildMemoryPinyinIndex();
        }
        STATE.dictionaryReady = true;
      } catch (e) {
        console.warn("[LocalDictionary] Khởi tạo IndexedDB lỗi:", e);
      }
    },

    openDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.INDEXED_DB.NAME, CONFIG.INDEXED_DB.VERSION);
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(CONFIG.INDEXED_DB.STORE_NAME)) {
            const store = db.createObjectStore(CONFIG.INDEXED_DB.STORE_NAME, { keyPath: "id" });
            store.createIndex("simplified", "s", { unique: false });
            store.createIndex("pinyin", "p", { unique: false });
            store.createIndex("cleanPinyin", "cp", { unique: false });
            store.createIndex("meaning", "m", { unique: false });
          }
        };
        request.onsuccess = (e) => {
          STATE.dbInstance = e.target.result;
          resolve(STATE.dbInstance);
        };
        request.onerror = (e) => reject(e.target.error);
      });
    },

    countWords() {
      return new Promise((resolve) => {
        if (!STATE.dbInstance) return resolve(0);
        const tx = STATE.dbInstance.transaction(CONFIG.INDEXED_DB.STORE_NAME, "readonly");
        const store = tx.objectStore(CONFIG.INDEXED_DB.STORE_NAME);
        const req = store.count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => resolve(0);
      });
    },

    async syncFromBackend() {
      try {
        const items = await API.call("dictionary.getAllForSync", {});
        if (!Array.isArray(items) || items.length === 0) return;

        const tx = STATE.dbInstance.transaction(CONFIG.INDEXED_DB.STORE_NAME, "readwrite");
        const store = tx.objectStore(CONFIG.INDEXED_DB.STORE_NAME);

        items.forEach(item => {
          const cleanPinyin = (item.p || "")
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
            .replace(/[1-5]/g, "")
            .replace(/ü/g, "v")
            .toLowerCase().replace(/[^a-z]/g, "");

          store.put({
            id: item.id || ("W-" + Math.random().toString(36).substring(2, 9)),
            s: item.s || "",
            t: item.t || item.s || "",
            p: item.p || "",
            cp: cleanPinyin,
            sv: item.sv || "",
            m: item.m || "",
            type: item.type || "",
            exZh: item.exZh || "",
            exVi: item.exVi || "",
            hsk: item.hsk || "HSK 1"
          });
        });

        await new Promise((res) => { tx.oncomplete = () => res(); });
        console.log(`[LocalDictionary] Đã đồng bộ ${items.length} từ vào IndexedDB.`);
        await this.buildMemoryPinyinIndex();
      } catch (err) {
        console.error("Lỗi sync từ điển:", err);
      }
    },

    async buildMemoryPinyinIndex() {
      if (!STATE.dbInstance) return;
      STATE.pinyinIndexMap.clear();

      const tx = STATE.dbInstance.transaction(CONFIG.INDEXED_DB.STORE_NAME, "readonly");
      const store = tx.objectStore(CONFIG.INDEXED_DB.STORE_NAME);
      const req = store.openCursor();

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const val = cursor.value;
          if (val.cp && val.s) {
            const arr = STATE.pinyinIndexMap.get(val.cp) || [];
            if (!arr.includes(val.s)) {
              arr.push(val.s);
              STATE.pinyinIndexMap.set(val.cp, arr);
            }
          }
          cursor.continue();
        }
      };
    },

    async search(query, mode = "ZH_VI") {
      const q = (query || "").trim().toLowerCase();
      if (!q) return [];

      return new Promise((resolve) => {
        if (!STATE.dbInstance) return resolve([]);
        const tx = STATE.dbInstance.transaction(CONFIG.INDEXED_DB.STORE_NAME, "readonly");
        const store = tx.objectStore(CONFIG.INDEXED_DB.STORE_NAME);
        const results = [];
        const req = store.openCursor();

        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && results.length < 35) {
            const item = cursor.value;
            let match = false;

            if (mode === "ZH_VI") {
              // Tra cứu theo chữ Hán, Pinyin, Pinyin sạch, âm Hán Việt
              if (
                item.s.toLowerCase().includes(q) ||
                (item.t && item.t.toLowerCase().includes(q)) ||
                item.p.toLowerCase().includes(q) ||
                item.cp.includes(q) ||
                item.sv.toLowerCase().includes(q)
              ) {
                match = true;
              }
            } else {
              // Tra cứu Việt -> Trung: theo nghĩa tiếng Việt, dịch câu ví dụ
              if (
                item.m.toLowerCase().includes(q) ||
                item.exVi.toLowerCase().includes(q) ||
                item.sv.toLowerCase().includes(q)
              ) {
                match = true;
              }
            }

            if (match) {
              results.push({
                simplified: item.s,
                traditional: item.t,
                pinyin: item.p,
                sino_vietnamese: item.sv,
                meaning_vi: item.m,
                word_type: item.type,
                example_zh: item.exZh,
                example_vi: item.exVi,
                hsk_level: item.hsk
              });
            }
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        req.onerror = () => resolve([]);
      });
    }
  };

  // ==========================================
  // 5. BUILT-IN CHINESE PINYIN IME (GLOBAL ACCESSIBLE)
  // ==========================================
  const PinyinEngine = {
    FALLBACK_MAP: {
      "ni": ["你", "呢", "拟", "泥"],
      "hao": ["好", "号", "毫", "耗"],
      "nihao": ["你好"],
      "xue": ["学", "雪", "血"],
      "xi": ["习", "西", "系", "洗", "细"],
      "xuexi": ["学习"],
      "lao": ["老", "劳", "落"],
      "shi": ["是", "师", "时", "十", "事", "市", "识"],
      "laoshi": ["老师"],
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
      "duoshao": ["多少"],
      "qian": ["钱", "前", "千"],
      "duoshaoqian": ["多少钱"],
      "piaoliang": ["漂亮"]
    },

    activeInput: null,
    currentBuffer: "",
    candidateList: [],
    selectedCandidateIdx: 0,

    init() {
      const applyMode = (mode) => {
        STATE.imeMode = mode;
        localStorage.setItem(CONFIG.STORAGE_KEYS.IME_MODE, mode);

        document.querySelectorAll(".ime-btn-vi").forEach(b => {
          if (mode === "VI") b.classList.add("active");
          else b.classList.remove("active");
        });

        document.querySelectorAll(".ime-btn-zh").forEach(b => {
          if (mode === "ZH") b.classList.add("active");
          else b.classList.remove("active");
        });

        if (mode === "ZH") {
          UI.toast("Đã kích hoạt Bộ gõ Pinyin (中文)", "info");
        } else {
          this.closePopover();
          UI.toast("Đã chuyển về Bộ gõ Tiếng Việt", "info");
        }
      };

      document.querySelectorAll(".ime-btn-vi").forEach(b => b.addEventListener("click", () => applyMode("VI")));
      document.querySelectorAll(".ime-btn-zh").forEach(b => b.addEventListener("click", () => applyMode("ZH")));

      // PHÍM TẮT TOÀN CỤC CHUYỂN NHANH IME: Ctrl + Shift hoặc Alt + Z
      document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey && e.shiftKey) || (e.altKey && e.key.toLowerCase() === 'z')) {
          e.preventDefault();
          applyMode(STATE.imeMode === "ZH" ? "VI" : "ZH");
          return;
        }
        this.handleKeyDown(e);
      });

      applyMode(STATE.imeMode);
    },

    handleKeyDown(e) {
      if (STATE.imeMode !== "ZH") return;
      const target = e.target;
      if (!target || (!target.classList.contains("pinyin-enabled") && target.tagName !== "TEXTAREA" && target.tagName !== "INPUT")) {
        return;
      }
      if (target.type === "password" || target.type === "date" || target.type === "time" || target.type === "file" || target.type === "number") {
        return;
      }

      this.activeInput = target;

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

      if (/^[a-zA-Z]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        this.currentBuffer += e.key.toLowerCase();
        this.updateCandidates();
      }
    },

    updateCandidates() {
      let candidates = STATE.pinyinIndexMap.get(this.currentBuffer);
      if (!candidates || candidates.length === 0) {
        candidates = this.FALLBACK_MAP[this.currentBuffer] || [];
      }

      if (candidates.length === 0) {
        this.candidateList = [this.currentBuffer];
      } else {
        this.candidateList = candidates.slice(0, 9);
      }
      this.selectedCandidateIdx = 0;
      this.renderPopover();
    },

    renderPopover() {
      const popover = document.getElementById("pinyin-ime-popover");
      const syllableText = document.getElementById("ime-syllable-text");
      const candidatesList = document.getElementById("ime-candidates-list");

      if (!this.activeInput || !popover) return;

      const rect = this.activeInput.getBoundingClientRect();
      popover.style.display = "block";
      popover.style.top = (window.scrollY + rect.bottom + 6) + "px";
      popover.style.left = (window.scrollX + Math.max(10, rect.left)) + "px";

      syllableText.innerText = `Pinyin: ${this.currentBuffer} (Phím [1-9] hoặc [Cách])`;
      candidatesList.innerHTML = this.candidateList.map((cand, idx) => `
        <span class="ime-candidate-item ${idx === this.selectedCandidateIdx ? 'selected' : ''}" data-idx="${idx}">
          <span style="font-size:11px; opacity:0.7;">${idx + 1}.</span>${cand}
        </span>
      `).join('');

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
  // 6. AUTHENTICATION MODULE
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
            // Toast đã kích hoạt trong API.call
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
        document.getElementById("sidebar-user-role").innerText = STATE.user.role === "TEACHER" ? "Lão Sư (Teacher)" : "Học Viên (Student)";
        
        if (STATE.user.avatar && STATE.user.avatar.trim() !== "") {
          document.getElementById("sidebar-user-avatar").src = STATE.user.avatar;
        }

        const isTeacher = (STATE.user.role === "TEACHER" || STATE.user.role === "ADMIN");
        const teacherBtns = [
          document.getElementById("btn-create-assignment-modal"),
          document.getElementById("btn-create-lesson-modal"),
          document.getElementById("btn-create-course-modal")
        ];
        teacherBtns.forEach(btn => {
          if (btn) btn.style.display = isTeacher ? "inline-flex" : "none";
        });

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
  // 7. ROUTER & NAVIGATION
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
        dashboard: "Bàn làm việc (工作台)",
        courses: "Khóa học & Lịch trình 1:1 (课程进度)",
        assignments: "Quản lý Bài tập & Nộp bài (作业中心)",
        "error-notebook": "Sổ lỗi sai (错题本)",
        "learning-journal": "Nhật ký phản tư học tập (学习反思)",
        dictionary: "Tra cứu Từ điển Hán - Việt 2 Chiều (汉越词典)",
        vocabulary: "Sổ từ vựng tích lũy (词汇笔记)",
        flashcards: "Học từ vựng Flashcards SM-2 (智能生词卡)",
        reports: "Báo cáo Đánh giá Tiến trình (学情报告)"
      };

      document.getElementById("page-current-title").innerText = titles[viewName] || "Learning Hub";
      lucide.createIcons();

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
        case "dictionary":
          Dictionary.initView();
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
  // 8. DASHBOARD MODULE (FIX DATE/TIME)
  // ==========================================
  const Dashboard = {
    async load() {
      try {
        if (STATE.user.role === "STUDENT") {
          const data = await API.call("dashboard.getStudent");
          
          document.getElementById("stat-completed-lessons").innerText = `${data.totalCompletedLessons}/${data.totalPlannedLessons}`;
          document.getElementById("stat-pending-tasks").innerText = data.pendingAssignments ? data.pendingAssignments.length : 0;
          document.getElementById("stat-avg-score").innerText = data.averageScore || "0.0";
          document.getElementById("stat-due-flashcards").innerText = data.dueFlashcardsCount || 0;

          const meetBtn = document.getElementById("btn-join-meet");
          if (data.upcomingLesson && data.upcomingLesson.meet_url) {
            meetBtn.href = data.upcomingLesson.meet_url;
            meetBtn.style.display = "inline-flex";

            const cleanDate = Utils.formatDateVN(data.upcomingLesson.lesson_date);
            const cleanStart = Utils.formatTimeVN(data.upcomingLesson.start_time);
            const cleanEnd = Utils.formatTimeVN(data.upcomingLesson.end_time);

            document.getElementById("dash-upcoming-lesson-info").innerHTML = `
              <div style="font-size:15px; font-weight:700; color:var(--primary); margin-bottom:4px;">${data.upcomingLesson.lesson_name}</div>
              <div style="font-size:13px; color:var(--text-muted); margin-bottom:8px;">
                <i data-lucide="calendar" style="width:14px; height:14px; display:inline-block; vertical-align:middle;"></i> <strong>${cleanDate}</strong> | 
                <i data-lucide="clock" style="width:14px; height:14px; display:inline-block; vertical-align:middle;"></i> <strong>${cleanStart} - ${cleanEnd}</strong>
              </div>
              <p style="font-size:13px; color:var(--text-main);">Chủ đề: <em>${data.upcomingLesson.topic || 'Chưa cập nhật'}</em></p>
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
                <td>${Utils.formatDateTimeVN(item.submission.submitted_at)}</td>
                <td><span class="chinese-seal-tag">${item.submission.status}</span></td>
                <td><strong>${item.grade ? item.grade.total_score + ' / ' + item.grade.max_score : '<span style="color:var(--warning);">Chờ chấm</span>'}</strong></td>
              </tr>
            `).join('');
          } else {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:20px;">Chưa có bài nộp nào.</td></tr>`;
          }

        } else {
          // TEACHER DASHBOARD
          const data = await API.call("dashboard.getTeacher");
          document.getElementById("stat-completed-lessons").innerText = data.activeCoursesCount + " Lớp";
          document.getElementById("stat-pending-tasks").innerText = data.pendingGradingCount;
          document.getElementById("stat-avg-score").innerText = "--";
          document.getElementById("stat-due-flashcards").innerText = data.totalStudentsCount + " Học sinh";

          document.getElementById("btn-join-meet").style.display = "none";
          document.getElementById("dash-upcoming-lesson-info").innerHTML = data.upcomingLessons && data.upcomingLessons.length > 0
            ? data.upcomingLessons.map(l => `
                <div style="padding:6px 0; border-bottom:1px dashed var(--border-color);">
                  • <strong>${l.lesson_name}</strong> (${Utils.formatDateVN(l.lesson_date)} | ${Utils.formatTimeVN(l.start_time)} - ${Utils.formatTimeVN(l.end_time)})
                </div>`).join('')
            : "Không có buổi học sắp tới.";

          const tbody = document.getElementById("dash-submissions-tbody");
          if (data.waitingGradingList && data.waitingGradingList.length > 0) {
            tbody.innerHTML = data.waitingGradingList.map(item => `
              <tr>
                <td><strong>${item.assignmentTitle}</strong></td>
                <td>Lần ${item.attemptNumber}</td>
                <td>${Utils.formatDateTimeVN(item.submittedAt)}</td>
                <td><span style="color:var(--warning); font-weight:700;">Cần chấm điểm</span></td>
                <td><button class="btn btn-primary btn-sm" onclick="App.Grading.openGradeModal('${item.submissionId}')">Chấm bài ngay</button></td>
              </tr>
            `).join('');
          } else {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:20px;">Không có bài tập nào cần chấm. Tuyệt vời!</td></tr>`;
          }
        }
        lucide.createIcons();
      } catch (e) {
        console.error(e);
      }
    }
  };

  // ==========================================
  // 9. COURSES & LESSONS (FORMAT DATE/TIME CHUẨN)
  // ==========================================
  const Courses = {
    init() {
      const btnOpenLes = document.getElementById("btn-create-lesson-modal");
      if (btnOpenLes) {
        btnOpenLes.addEventListener("click", () => {
          const today = new Date().toISOString().split("T")[0];
          document.getElementById("les-date").value = today;
          UI.openModal("lesson-modal");
        });
      }

      const lesForm = document.getElementById("lesson-create-form");
      if (lesForm) {
        lesForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const btn = document.getElementById("btn-submit-lesson-create");
          try {
            btn.disabled = true;
            btn.innerText = "Đang lên lịch...";
            await API.call("lesson.create", {
              courseId: STATE.activeCourse ? STATE.activeCourse.course_id : "",
              lessonName: document.getElementById("les-name").value.trim(),
              lessonDate: document.getElementById("les-date").value,
              startTime: document.getElementById("les-start-time").value,
              endTime: document.getElementById("les-end-time").value,
              topic: document.getElementById("les-topic").value.trim(),
              objectives: document.getElementById("les-objectives").value.trim(),
              meetUrl: document.getElementById("les-meet-url").value.trim()
            });
            UI.toast("Đã lên lịch buổi học mới thành công!", "success");
            UI.closeModal("lesson-modal");
            lesForm.reset();
            this.load();
          } catch (err) {
          } finally {
            btn.disabled = false;
            btn.innerText = "Lên lịch buổi học";
          }
        });
      }

      const btnOpenCrs = document.getElementById("btn-create-course-modal");
      if (btnOpenCrs) {
        btnOpenCrs.addEventListener("click", () => {
          const today = new Date().toISOString().split("T")[0];
          document.getElementById("crs-start-date").value = today;
          UI.openModal("course-modal");
        });
      }

      const crsForm = document.getElementById("course-create-form");
      if (crsForm) {
        crsForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const btn = document.getElementById("btn-submit-course-create");
          try {
            btn.disabled = true;
            btn.innerText = "Đang khởi tạo...";
            const newCourse = await API.call("course.create", {
              courseName: document.getElementById("crs-name").value.trim(),
              hskLevel: document.getElementById("crs-level").value,
              totalLessons: Number(document.getElementById("crs-total-lessons").value),
              startDate: document.getElementById("crs-start-date").value
            });
            UI.toast("Đã tạo khóa học thành công!", "success");
            UI.closeModal("course-modal");
            crsForm.reset();
            STATE.activeCourse = newCourse;
            this.load();
          } catch (err) {
          } finally {
            btn.disabled = false;
            btn.innerText = "Khởi tạo khóa học";
          }
        });
      }
    },

    async load() {
      const container = document.getElementById("courses-lessons-container");
      container.innerHTML = "<p style='color:var(--text-muted);'>Đang tải danh sách khóa học...</p>";
      try {
        const courses = await API.call("course.list");
        if (courses.length === 0) {
          container.innerHTML = `
            <div class='editorial-card' style='text-align:center; padding:30px;'>
              <p style='color:var(--text-muted); margin-bottom:12px;'>Chưa có khóa học nào được chỉ định.</p>
              ${STATE.user.role === 'TEACHER' ? `<button class='btn btn-primary btn-sm' onclick="App.UI.openModal('course-modal')">Tạo khóa học ngay</button>` : ''}
            </div>`;
          return;
        }
        STATE.activeCourse = courses[0];

        const lessons = await API.call("lesson.list", { courseId: STATE.activeCourse.course_id });
        container.innerHTML = `
          <div class="editorial-card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
              <div>
                <h3 style="font-size:18px; font-weight:700; color:var(--primary);">${STATE.activeCourse.course_name}</h3>
                <span class="chinese-seal-tag">${STATE.activeCourse.hsk_level}</span>
                <span style="font-size:13px; color:var(--text-muted); margin-left:8px;">Khai giảng: <strong>${Utils.formatDateVN(STATE.activeCourse.start_date)}</strong></span>
              </div>
            </div>
            
            <div class="hub-table-wrapper">
              <table class="hub-table">
                <thead>
                  <tr>
                    <th>Buổi</th>
                    <th>Chủ đề & Mục tiêu trọng tâm</th>
                    <th>Thời gian học</th>
                    <th>Trạng thái</th>
                    <th>Tác vụ</th>
                  </tr>
                </thead>
                <tbody>
                  ${lessons.length > 0 ? lessons.map((les, idx) => `
                    <tr>
                      <td><strong style="color:var(--primary);">#${idx + 1}</strong></td>
                      <td>
                        <strong>${les.lesson_name}</strong><br>
                        <span style="font-size:12px; color:var(--text-muted);">${les.topic || 'Chưa có chủ đề'}</span>
                      </td>
                      <td>
                        <strong>${Utils.formatDateVN(les.lesson_date)}</strong><br>
                        <span style="font-size:12px; color:var(--text-muted);">${Utils.formatTimeVN(les.start_time)} - ${Utils.formatTimeVN(les.end_time)}</span>
                      </td>
                      <td><span class="chinese-seal-tag">${les.status}</span></td>
                      <td>
                        ${les.meet_url ? `<a href="${les.meet_url}" target="_blank" class="btn btn-outline btn-sm"><i data-lucide="video"></i> Vào học</a>` : ''}
                      </td>
                    </tr>
                  `).join('') : `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:20px;">Chưa có buổi học nào trong khóa.</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>
        `;
        lucide.createIcons();
      } catch (e) {
        container.innerHTML = "<p style='color:var(--danger);'>Không thể tải thông tin khóa học.</p>";
      }
    }
  };

  // ==========================================
  // 10. ASSIGNMENTS & SUBMISSION (FULL MULTI-MEDIA)
  // ==========================================
  const Assignments = {
    tempAssignmentFiles: [],
    tempAssignmentLinks: [],
    tempSubmissionFiles: [],
    tempSubmissionLinks: [],

    init() {
      // Nút mở modal giao bài tập
      const btnOpenAss = document.getElementById("btn-create-assignment-modal");
      if (btnOpenAss) {
        btnOpenAss.addEventListener("click", () => {
          const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
          document.getElementById("ass-deadline").value = nextWeek;
          this.tempAssignmentFiles = [];
          this.tempAssignmentLinks = [];
          this.renderAssignmentAttachmentsList();
          this.renderAssignmentLinksList();
          UI.openModal("assignment-modal");
        });
      }

      // Xử lý đính kèm file trong tạo bài tập
      const assFileInput = document.getElementById("ass-file-input");
      if (assFileInput) {
        assFileInput.addEventListener("change", async (e) => {
          if (!e.target.files || e.target.files.length === 0) return;
          const file = e.target.files[0];
          try {
            UI.toast(`Đang tải file "${file.name}" lên Google Drive...`, "info");
            const base64 = await Utils.fileToBase64(file);
            const uploaded = await API.call("file.upload", {
              fileName: file.name,
              mimeType: file.type,
              base64Content: base64,
              folderName: "Assignment_Materials"
            });
            this.tempAssignmentFiles.push({
              fileId: uploaded.file_id,
              fileName: uploaded.file_name,
              fileUrl: uploaded.file_url,
              mimeType: uploaded.mime_type
            });
            this.renderAssignmentAttachmentsList();
            UI.toast("Đã đính kèm file thành công!", "success");
            assFileInput.value = "";
          } catch (err) {
            UI.toast("Tải file thất bại", "error");
          }
        });
      }

      // Xử lý thêm Link trong tạo bài tập
      const btnAddAssLink = document.getElementById("btn-add-ass-link");
      if (btnAddAssLink) {
        btnAddAssLink.addEventListener("click", () => {
          const titleInput = document.getElementById("ass-link-title");
          const urlInput = document.getElementById("ass-link-url");
          const title = titleInput.value.trim();
          const url = urlInput.value.trim();

          if (!url) {
            UI.toast("Vui lòng nhập đường dẫn URL!", "error");
            return;
          }
          this.tempAssignmentLinks.push({ title: title || url, url: url });
          titleInput.value = "";
          urlInput.value = "";
          this.renderAssignmentLinksList();
        });
      }

      // Submit Form Giao bài tập
      const assForm = document.getElementById("assignment-create-form");
      if (assForm) {
        assForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const btn = document.getElementById("btn-submit-assignment-create");
          try {
            btn.disabled = true;
            btn.innerText = "Đang xuất bản bài tập...";
            await API.call("assignment.create", {
              courseId: STATE.activeCourse ? STATE.activeCourse.course_id : "",
              title: document.getElementById("ass-title").value.trim(),
              assignmentType: document.getElementById("ass-type").value,
              deadline: document.getElementById("ass-deadline").value,
              description: document.getElementById("ass-desc").value.trim(),
              instructions: document.getElementById("ass-instructions").value.trim(),
              maxScore: Number(document.getElementById("ass-max-score").value),
              maxAttempts: Number(document.getElementById("ass-max-attempts").value),
              attachmentFiles: this.tempAssignmentFiles,
              externalLinks: this.tempAssignmentLinks,
              publish: true
            });
            UI.toast("Đã giao bài tập mới thành công!", "success");
            UI.closeModal("assignment-modal");
            assForm.reset();
            this.tempAssignmentFiles = [];
            this.tempAssignmentLinks = [];
            this.load();
          } catch (err) {
          } finally {
            btn.disabled = false;
            btn.innerText = "Xuất bản bài tập";
          }
        });
      }

      // Học sinh nộp bài: Thêm Link
      const btnAddSubLink = document.getElementById("btn-add-sub-link");
      if (btnAddSubLink) {
        btnAddSubLink.addEventListener("click", () => {
          const titleInput = document.getElementById("sub-link-title");
          const urlInput = document.getElementById("sub-link-url");
          const title = titleInput.value.trim();
          const url = urlInput.value.trim();

          if (!url) {
            UI.toast("Vui lòng cung cấp link bài nộp!", "error");
            return;
          }
          this.tempSubmissionLinks.push({ title: title || url, url: url });
          titleInput.value = "";
          urlInput.value = "";
          this.renderSubmissionLinksList();
        });
      }

      // Học sinh nộp bài: Upload File
      const subFileInput = document.getElementById("sub-file-input");
      if (subFileInput) {
        subFileInput.addEventListener("change", async (e) => {
          if (!e.target.files || e.target.files.length === 0) return;
          const file = e.target.files[0];
          try {
            UI.toast(`Đang tải file bài làm "${file.name}"...`, "info");
            const base64 = await Utils.fileToBase64(file);
            const uploaded = await API.call("file.upload", {
              fileName: file.name,
              mimeType: file.type,
              base64Content: base64,
              folderName: STATE.user.userId
            });
            this.tempSubmissionFiles.push({
              fileId: uploaded.file_id,
              fileName: uploaded.file_name,
              fileUrl: uploaded.file_url,
              mimeType: uploaded.mime_type
            });
            this.renderSubmissionFilesList();
            UI.toast("Đã tải lên bài làm!", "success");
            subFileInput.value = "";
          } catch (err) {
            UI.toast("Lỗi tải file bài làm", "error");
          }
        });
      }

      // Submit Form Nộp bài
      const subForm = document.getElementById("submission-form");
      if (subForm) {
        subForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const assId = document.getElementById("sub-assignment-id").value;
          const text = document.getElementById("sub-text-content").value;
          const submitBtn = document.getElementById("btn-submit-work");

          if (!text && this.tempSubmissionFiles.length === 0 && this.tempSubmissionLinks.length === 0) {
            UI.toast("Vui lòng nhập văn bản, đính kèm file hoặc gửi link bài làm!", "error");
            return;
          }

          try {
            submitBtn.disabled = true;
            submitBtn.innerText = "Đang nộp bài...";

            const fileIds = this.tempSubmissionFiles.map(f => f.fileId);

            await API.call("submission.create", {
              assignmentId: assId,
              textContent: text,
              submissionType: fileIds.length > 0 ? "Mixed" : (this.tempSubmissionLinks.length > 0 ? "Link" : "Text"),
              fileIds: fileIds,
              externalLinks: this.tempSubmissionLinks
            });

            UI.toast("Nộp bài thành công!", "success");
            UI.closeModal("submission-modal");
            subForm.reset();
            this.tempSubmissionFiles = [];
            this.tempSubmissionLinks = [];
            Router.loadViewData("dashboard");
          } catch (err) {
          } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = "Nộp bài chính thức";
          }
        });
      }
    },

    renderAssignmentAttachmentsList() {
      const container = document.getElementById("ass-files-preview-list");
      if (!container) return;
      container.innerHTML = this.tempAssignmentFiles.map((f, idx) => `
        <div class="attachment-pill">
          <i data-lucide="paperclip" style="width:14px; height:14px;"></i>
          <span>${Utils.escapeHtml(f.fileName)}</span>
          <span style="cursor:pointer; color:var(--danger); margin-left:6px;" onclick="App.Assignments.removeAssignmentFile(${idx})">✕</span>
        </div>
      `).join('');
      lucide.createIcons();
    },

    removeAssignmentFile(idx) {
      this.tempAssignmentFiles.splice(idx, 1);
      this.renderAssignmentAttachmentsList();
    },

    renderAssignmentLinksList() {
      const container = document.getElementById("ass-links-preview-list");
      if (!container) return;
      container.innerHTML = this.tempAssignmentLinks.map((l, idx) => `
        <div class="attachment-pill">
          <i data-lucide="link-2" style="width:14px; height:14px;"></i>
          <a href="${l.url}" target="_blank" style="color:inherit; text-decoration:none;">${Utils.escapeHtml(l.title)}</a>
          <span style="cursor:pointer; color:var(--danger); margin-left:6px;" onclick="App.Assignments.removeAssignmentLink(${idx})">✕</span>
        </div>
      `).join('');
      lucide.createIcons();
    },

    removeAssignmentLink(idx) {
      this.tempAssignmentLinks.splice(idx, 1);
      this.renderAssignmentLinksList();
    },

    renderSubmissionFilesList() {
      const container = document.getElementById("sub-files-preview-list");
      if (!container) return;
      container.innerHTML = this.tempSubmissionFiles.map((f, idx) => `
        <div class="attachment-pill">
          <i data-lucide="file-check" style="width:14px; height:14px;"></i>
          <span>${Utils.escapeHtml(f.fileName)}</span>
          <span style="cursor:pointer; color:var(--danger); margin-left:6px;" onclick="App.Assignments.removeSubmissionFile(${idx})">✕</span>
        </div>
      `).join('');
      lucide.createIcons();
    },

    removeSubmissionFile(idx) {
      this.tempSubmissionFiles.splice(idx, 1);
      this.renderSubmissionFilesList();
    },

    renderSubmissionLinksList() {
      const container = document.getElementById("sub-links-preview-list");
      if (!container) return;
      container.innerHTML = this.tempSubmissionLinks.map((l, idx) => `
        <div class="attachment-pill">
          <i data-lucide="external-link" style="width:14px; height:14px;"></i>
          <a href="${l.url}" target="_blank" style="color:inherit;">${Utils.escapeHtml(l.title)}</a>
          <span style="cursor:pointer; color:var(--danger); margin-left:6px;" onclick="App.Assignments.removeSubmissionLink(${idx})">✕</span>
        </div>
      `).join('');
      lucide.createIcons();
    },

    removeSubmissionLink(idx) {
      this.tempSubmissionLinks.splice(idx, 1);
      this.renderSubmissionLinksList();
    },

    async load() {
      const container = document.getElementById("assignments-list-container");
      container.innerHTML = "<p style='color:var(--text-muted);'>Đang nạp danh sách bài tập...</p>";
      try {
        if (!STATE.activeCourse) {
          const courses = await API.call("course.list");
          if (courses.length > 0) STATE.activeCourse = courses[0];
        }

        const assList = await API.call("assignment.list", { courseId: STATE.activeCourse ? STATE.activeCourse.course_id : "" });
        if (assList.length === 0) {
          container.innerHTML = `
            <div class='editorial-card' style='text-align:center; padding:30px;'>
              <p style='color:var(--text-muted); margin-bottom:12px;'>Chưa có bài tập nào được giao.</p>
              ${STATE.user.role === 'TEACHER' ? `<button class='btn btn-primary btn-sm' onclick="App.UI.openModal('assignment-modal')">Giao bài tập mới ngay</button>` : ''}
            </div>`;
          return;
        }

        container.innerHTML = assList.map(a => `
          <div class="editorial-card">
            <div class="card-header-clean">
              <div>
                <span class="chinese-seal-tag">${a.assignment_type}</span>
                <h3 style="font-size:17px; font-weight:700; margin-top:6px; color:var(--text-main); font-family:var(--font-editorial);">${a.title}</h3>
                <div style="font-size:12.5px; color:var(--text-muted); margin-top:4px;">
                  Hạn chót: <strong>${Utils.formatDateVN(a.deadline)}</strong> | Điểm tối đa: <strong>${a.max_score}</strong>
                </div>
              </div>
              <div>
                ${STATE.user.role === "STUDENT" 
                  ? `<button class="btn btn-primary btn-sm" onclick="App.Assignments.openSubmitModal('${a.assignment_id}', '${a.title.replace(/'/g, "\\'")}')">Làm & Nộp bài</button>`
                  : `<span class="chinese-seal-tag" style="background:rgba(200, 155, 56, 0.15); color:var(--warm-gold);">${a.status}</span>`
                }
              </div>
            </div>

            <div style="font-size:13.5px; color:var(--text-main); margin-bottom:10px;">${a.description || 'Không có mô tả thêm.'}</div>
            
            ${a.instructions ? `
              <div style="font-size:13px; background:var(--surface-parchment); padding:12px 16px; border-radius:var(--radius-sm); border-left:3px solid var(--primary); margin-bottom:12px;">
                <strong><i data-lucide="info" style="width:14px; height:14px; display:inline-block; vertical-align:middle;"></i> Hướng dẫn của Lão Sư:</strong>
                <p style="margin-top:4px;">${a.instructions}</p>
              </div>
            ` : ''}

            <!-- File đính kèm của đề bài -->
            ${a.attachmentFilesList && a.attachmentFilesList.length > 0 ? `
              <div style="margin-top:10px;">
                <span style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">Tài liệu / Đề bài đính kèm:</span>
                <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:6px;">
                  ${a.attachmentFilesList.map(f => `
                    <a href="${f.fileUrl}" target="_blank" class="attachment-pill">
                      <i data-lucide="paperclip" style="width:14px; height:14px;"></i>
                      <span>${Utils.escapeHtml(f.fileName)}</span>
                    </a>
                  `).join('')}
                </div>
              </div>
            ` : ''}

            <!-- Liên kết đính kèm của đề bài -->
            ${a.externalLinksList && a.externalLinksList.length > 0 ? `
              <div style="margin-top:10px;">
                <span style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">Liên kết tham khảo:</span>
                <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:6px;">
                  ${a.externalLinksList.map(l => `
                    <a href="${l.url}" target="_blank" class="attachment-pill">
                      <i data-lucide="external-link" style="width:14px; height:14px;"></i>
                      <span>${Utils.escapeHtml(l.title)}</span>
                    </a>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>
        `).join('');
        lucide.createIcons();
      } catch (e) {
        container.innerHTML = "<p style='color:var(--danger);'>Lỗi nạp bài tập.</p>";
      }
    },

    openSubmitModal(assignmentId, title) {
      document.getElementById("sub-assignment-id").value = assignmentId;
      document.getElementById("sub-modal-title").innerText = `Nộp bài: ${title}`;
      document.getElementById("sub-text-content").value = "";
      this.tempSubmissionFiles = [];
      this.tempSubmissionLinks = [];
      this.renderSubmissionFilesList();
      this.renderSubmissionLinksList();
      UI.openModal("submission-modal");
    }
  };

  // ==========================================
  // 11. GRADING MODULE (HỖ TRỢ BÀI MẪU & ĐA PHƯƠNG TIỆN)
  // ==========================================
  const Grading = {
    tempModelFiles: [],
    tempModelLinks: [],

    init() {
      // Giáo viên upload file bài mẫu
      const modelFileInput = document.getElementById("grade-model-file-input");
      if (modelFileInput) {
        modelFileInput.addEventListener("change", async (e) => {
          if (!e.target.files || e.target.files.length === 0) return;
          const file = e.target.files[0];
          try {
            UI.toast(`Đang tải file bài mẫu "${file.name}"...`, "info");
            const base64 = await Utils.fileToBase64(file);
            const uploaded = await API.call("file.upload", {
              fileName: file.name,
              mimeType: file.type,
              base64Content: base64,
              folderName: "Model_Solutions"
            });
            this.tempModelFiles.push({
              fileId: uploaded.file_id,
              fileName: uploaded.file_name,
              fileUrl: uploaded.file_url,
              mimeType: uploaded.mime_type
            });
            this.renderModelFilesList();
            UI.toast("Đã thêm file bài mẫu!", "success");
            modelFileInput.value = "";
          } catch (err) {
            UI.toast("Lỗi tải file bài mẫu", "error");
          }
        });
      }

      // Giáo viên thêm link bài mẫu
      const btnAddModelLink = document.getElementById("btn-add-model-link");
      if (btnAddModelLink) {
        btnAddModelLink.addEventListener("click", () => {
          const titleInput = document.getElementById("grade-model-link-title");
          const urlInput = document.getElementById("grade-model-link-url");
          const title = titleInput.value.trim();
          const url = urlInput.value.trim();

          if (!url) {
            UI.toast("Vui lòng nhập URL tài liệu mẫu!", "error");
            return;
          }
          this.tempModelLinks.push({ title: title || url, url: url });
          titleInput.value = "";
          urlInput.value = "";
          this.renderModelLinksList();
        });
      }

      const form = document.getElementById("grading-form");
      if (!form) return;
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const subId = document.getElementById("grade-sub-id").value;
        const totalScore = document.getElementById("grade-total-score").value;
        const grammar = document.getElementById("grade-rubric-grammar").value;
        const feedback = document.getElementById("grade-feedback-text").value;
        const modelSolutionText = document.getElementById("grade-model-solution-text").value;

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
            modelSolutionText: modelSolutionText,
            modelLinks: this.tempModelLinks,
            modelFiles: this.tempModelFiles,
            errorEntries: errorEntries
          });

          UI.toast("Đã lưu kết quả chấm bài và bài mẫu!", "success");
          UI.closeModal("grading-modal");
          Router.loadViewData("dashboard");
        } catch (err) {
        }
      });
    },

    renderModelFilesList() {
      const container = document.getElementById("grade-model-files-list");
      if (!container) return;
      container.innerHTML = this.tempModelFiles.map((f, idx) => `
        <div class="attachment-pill">
          <i data-lucide="file-text" style="width:14px; height:14px;"></i>
          <span>${Utils.escapeHtml(f.fileName)}</span>
          <span style="cursor:pointer; color:var(--danger); margin-left:6px;" onclick="App.Grading.removeModelFile(${idx})">✕</span>
        </div>
      `).join('');
      lucide.createIcons();
    },

    removeModelFile(idx) {
      this.tempModelFiles.splice(idx, 1);
      this.renderModelFilesList();
    },

    renderModelLinksList() {
      const container = document.getElementById("grade-model-links-list");
      if (!container) return;
      container.innerHTML = this.tempModelLinks.map((l, idx) => `
        <div class="attachment-pill">
          <i data-lucide="external-link" style="width:14px; height:14px;"></i>
          <span>${Utils.escapeHtml(l.title)}</span>
          <span style="cursor:pointer; color:var(--danger); margin-left:6px;" onclick="App.Grading.removeModelLink(${idx})">✕</span>
        </div>
      `).join('');
      lucide.createIcons();
    },

    removeModelLink(idx) {
      this.tempModelLinks.splice(idx, 1);
      this.renderModelLinksList();
    },

    async openGradeModal(submissionId) {
      document.getElementById("grade-sub-id").value = submissionId;
      const detail = await API.call("submission.getDetail", { submissionId });
      
      const summaryBox = document.getElementById("grading-submission-summary");
      summaryBox.innerHTML = `
        <div style="font-size:14px; font-weight:700; color:var(--primary); margin-bottom:6px;">
          Bài nộp Lần ${detail.submission.attempt_number} (Gửi lúc: ${Utils.formatDateTimeVN(detail.submission.submitted_at)})
        </div>
        <div style="margin:8px 0; padding:12px; background:#fff; border:1px solid var(--border-color); border-radius:var(--radius-sm); font-size:14px; line-height:1.6;">
          ${detail.submission.text_content ? detail.submission.text_content.replace(/\n/g, '<br>') : '<em style="color:var(--text-muted);">Không có bài viết văn bản.</em>'}
        </div>

        ${detail.files && detail.files.length > 0 ? `
          <div style="margin-top:8px;">
            <span style="font-size:12px; font-weight:700; color:var(--text-muted);">FILE ĐÍNH KÈM CỦA HỌC SINH:</span>
            <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:4px;">
              ${detail.files.map(f => `
                <a href="${f.file_url}" target="_blank" class="attachment-pill">
                  <i data-lucide="paperclip" style="width:14px; height:14px;"></i>
                  <span>${Utils.escapeHtml(f.file_name)}</span>
                </a>
              `).join('')}
            </div>
          </div>
        ` : ''}

        ${detail.submission.externalLinksList && detail.submission.externalLinksList.length > 0 ? `
          <div style="margin-top:8px;">
            <span style="font-size:12px; font-weight:700; color:var(--text-muted);">LIÊN KẾT HỌC SINH GỬI:</span>
            <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:4px;">
              ${detail.submission.externalLinksList.map(l => `
                <a href="${l.url}" target="_blank" class="attachment-pill">
                  <i data-lucide="external-link" style="width:14px; height:14px;"></i>
                  <span>${Utils.escapeHtml(l.title)}</span>
                </a>
              `).join('')}
            </div>
          </div>
        ` : ''}
      `;

      // Nạp dữ liệu cũ nếu đã từng chấm
      if (detail.grade) {
        document.getElementById("grade-total-score").value = detail.grade.total_score || "";
        document.getElementById("grade-feedback-text").value = detail.grade.feedback_text || "";
        document.getElementById("grade-model-solution-text").value = detail.grade.model_solution_text || "";
        this.tempModelFiles = detail.grade.modelFilesList || [];
        this.tempModelLinks = detail.grade.modelLinksList || [];
      } else {
        document.getElementById("grade-total-score").value = "";
        document.getElementById("grade-feedback-text").value = "";
        document.getElementById("grade-model-solution-text").value = "";
        this.tempModelFiles = [];
        this.tempModelLinks = [];
      }

      this.renderModelFilesList();
      this.renderModelLinksList();
      lucide.createIcons();
      UI.openModal("grading-modal");
    }
  };

  // ==========================================
  // 12. DICTIONARY MODULE (TÁCH RIÊNG 2 CHIỀU TRA CỨU)
  // ==========================================
  const Dictionary = {
    init() {
      // Chuyển đổi tab chiều tra cứu
      document.querySelectorAll(".dict-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const mode = btn.getAttribute("data-mode");
          STATE.dictMode = mode;
          document.querySelectorAll(".dict-tab-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");

          const input = document.getElementById("dict-search-input");
          if (mode === "ZH_VI") {
            input.placeholder = "Gõ chữ Hán, Pinyin (VD: 你好, nihao, lao shi)...";
          } else {
            input.placeholder = "Gõ nghĩa Tiếng Việt (VD: xin chào, giáo viên, xinh đẹp)...";
          }
          this.triggerSearch();
        });
      });

      const btn = document.getElementById("btn-dict-search");
      const input = document.getElementById("dict-search-input");
      if (btn) btn.addEventListener("click", () => this.triggerSearch());
      if (input) {
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !document.getElementById("pinyin-ime-popover").style.display.includes("block")) {
            this.triggerSearch();
          }
        });
      }
    },

    initView() {
      // Focus vào ô tìm kiếm khi mở view
      const input = document.getElementById("dict-search-input");
      if (input) input.focus();
    },

    async triggerSearch() {
      const input = document.getElementById("dict-search-input");
      if (!input) return;
      const query = input.value.trim();
      const resBox = document.getElementById("dict-search-results");
      if (!query) {
        resBox.innerHTML = "<p style='color:var(--text-muted); padding:20px; text-align:center;'>Vui lòng nhập từ khóa để tra cứu.</p>";
        return;
      }

      resBox.innerHTML = "<p style='color:var(--text-muted); padding:10px;'>Đang tra cứu từ điển...</p>";

      try {
        let results = await LocalDictionary.search(query, STATE.dictMode);

        if (results.length === 0) {
          results = await API.call("dictionary.search", { query, mode: STATE.dictMode });
        }

        if (results.length === 0) {
          resBox.innerHTML = `
            <div style="text-align:center; padding:30px; color:var(--text-muted);">
              <i data-lucide="help-circle" style="width:32px; height:32px; margin-bottom:8px;"></i>
              <p>Không tìm thấy mục từ phù hợp theo chiều tra cứu hiện tại.</p>
              <p style="font-size:12px; margin-top:4px;">Hãy thử đổi tab giữa <strong>Trung ➔ Việt</strong> hoặc <strong>Việt ➔ Trung</strong>.</p>
            </div>`;
          lucide.createIcons();
          return;
        }

        resBox.innerHTML = results.map(item => `
          <div class="dict-result-row">
            <div>
              <div style="display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;">
                <span class="zh-serif" style="font-size:28px; font-weight:700; color:var(--primary);">${item.simplified}</span>
                ${item.traditional && item.traditional !== item.simplified ? `<span style="font-size:16px; color:var(--text-muted);">[Phồn thể: ${item.traditional}]</span>` : ''}
                <span style="font-size:16px; color:var(--warm-gold); font-weight:600;">${item.pinyin}</span>
                ${item.sino_vietnamese ? `<span style="font-size:12px; color:var(--jade-green); font-weight:600;">[Hán Việt: ${item.sino_vietnamese}]</span>` : ''}
                <span class="chinese-seal-tag">${item.hsk_level || 'HSK'}</span>
              </div>
              <div style="font-size:15px; font-weight:600; margin-top:6px; color:var(--text-main);">${item.meaning_vi}</div>
              ${item.example_zh ? `
                <div style="font-size:13px; color:var(--text-muted); margin-top:6px; background:var(--surface-parchment); padding:8px 12px; border-radius:4px;">
                  Ví dụ: <strong class="zh-text" style="color:var(--text-main);">${item.example_zh}</strong> — <em>${item.example_vi || ''}</em>
                </div>` : ''
              }
            </div>
            <button class="btn btn-outline btn-sm" onclick="App.Vocabulary.addFromDict('${item.simplified}', '${item.pinyin}', '${item.meaning_vi.replace(/'/g, "\\'")}')">
              <i data-lucide="bookmark-plus"></i> Lưu sổ từ
            </button>
          </div>
        `).join('');
        lucide.createIcons();
      } catch (e) {
        resBox.innerHTML = "<p style='color:var(--danger);'>Lỗi tra cứu từ điển.</p>";
      }
    }
  };

  // ==========================================
  // 13. VOCABULARY NOTEBOOK
  // ==========================================
  const Vocabulary = {
    init() {
      const btnOpenVoc = document.getElementById("btn-add-vocab-modal");
      if (btnOpenVoc) {
        btnOpenVoc.addEventListener("click", () => {
          UI.openModal("vocab-modal");
        });
      }

      const vocForm = document.getElementById("vocab-create-form");
      if (vocForm) {
        vocForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const btn = document.getElementById("btn-submit-vocab-create");
          try {
            btn.disabled = true;
            btn.innerText = "Đang lưu...";
            await API.call("vocabulary.create", {
              simplified: document.getElementById("voc-simplified").value.trim(),
              pinyin: document.getElementById("voc-pinyin").value.trim(),
              vietnameseMeaning: document.getElementById("voc-meaning").value.trim(),
              wordType: document.getElementById("voc-type").value.trim(),
              hskLevel: document.getElementById("voc-level").value,
              exampleZh: document.getElementById("voc-example-zh").value.trim(),
              exampleVi: document.getElementById("voc-example-vi").value.trim(),
              source: "MANUAL"
            });
            UI.toast("Đã thêm từ vựng mới vào sổ tay!", "success");
            UI.closeModal("vocab-modal");
            vocForm.reset();
            this.load();
          } catch (err) {
          } finally {
            btn.disabled = false;
            btn.innerText = "Lưu vào sổ từ";
          }
        });
      }
    },

    async load() {
      const tbody = document.getElementById("vocab-table-tbody");
      tbody.innerHTML = "<tr><td colspan='6' style='text-align:center; padding:20px;'>Đang nạp sổ từ vựng...</td></tr>";
      try {
        const list = await API.call("vocabulary.list");
        if (list.length === 0) {
          tbody.innerHTML = "<tr><td colspan='6' style='text-align:center; color:var(--text-muted); padding:30px;'>Sổ từ vựng đang trống. Hãy tra từ điển và lưu từ mới nhé!</td></tr>";
          return;
        }

        tbody.innerHTML = list.map(item => {
          const w = item.wordData || {};
          return `
            <tr>
              <td><strong class="zh-serif" style="font-size:22px; color:var(--primary);">${w.simplified || 'N/A'}</strong></td>
              <td style="color:var(--warm-gold); font-weight:600;">${w.pinyin || ''}</td>
              <td><strong>${w.vietnamese_meaning || ''}</strong></td>
              <td><span class="chinese-seal-tag">${w.hsk_level || 'HSK 1'}</span></td>
              <td style="font-size:12.5px; color:var(--text-muted);">${w.example_zh || ''}</td>
              <td>
                <button class="btn btn-outline btn-sm" onclick="App.Vocabulary.toggleFavorite('${item.entryId}', ${!item.isFavorite})">
                  ${item.isFavorite ? '★ Đã lưu' : '☆ Yêu thích'}
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
  // 14. FLASHCARDS (SM-2)
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
          <select id="flashcard-deck-select" class="form-select" style="width:auto; display:inline-block;">
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
        document.getElementById("fc-hanzi").innerText = "太棒了!";
        frontPane.querySelector("p").innerText = "Bạn đã hoàn thành tất cả các thẻ ôn tập hôm nay!";
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
  // 15. ERROR NOTEBOOK & JOURNAL
  // ==========================================
  const ErrorNotebook = {
    async load() {
      const tbody = document.getElementById("error-notebook-tbody");
      tbody.innerHTML = "<tr><td colspan='5' style='text-align:center; padding:20px;'>Đang tải dữ liệu...</td></tr>";
      try {
        const errors = await API.call("errorNotebook.list");
        if (errors.length === 0) {
          tbody.innerHTML = "<tr><td colspan='5' style='text-align:center; color:var(--text-muted); padding:30px;'>Chưa có lỗi sai nào. Học rất tốt!</td></tr>";
          return;
        }

        tbody.innerHTML = errors.map(err => `
          <tr>
            <td style="color:var(--danger); font-weight:600;">${err.wrong_text}</td>
            <td style="color:var(--success); font-weight:600;">${err.correct_text}</td>
            <td style="font-size:13px;">${err.explanation}</td>
            <td><span class="chinese-seal-tag">${err.category}</span></td>
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
          <h4 style="font-size:16px; font-weight:700; margin:24px 0 14px; color:var(--primary); font-family:var(--font-editorial);">Lịch sử nhật ký phản tư</h4>
          ${entries.map(j => `
            <div class="editorial-card" style="margin-bottom:14px; padding:20px;">
              <div style="display:flex; justify-content:space-between; font-size:12.5px; color:var(--text-muted); margin-bottom:8px;">
                <span>Ngày ghi: <strong>${Utils.formatDateVN(j.entry_date)}</strong></span>
                <span>Mức độ tự tin: ${'⭐'.repeat(Number(j.comprehension_rating))}</span>
              </div>
              <div style="font-size:14px; font-weight:600; color:var(--text-main);">${j.learned_today}</div>
              ${j.difficulties ? `<div style="font-size:13px; color:var(--warning); margin-top:6px;">Khúc mắc: ${j.difficulties}</div>` : ''}
              ${j.teacher_reply ? `<div style="margin-top:10px; padding:12px; background:var(--jade-light); border-left:3px solid var(--jade-green); border-radius:4px; font-size:13px; color:var(--jade-dark);"><strong>Lão Sư phản hồi:</strong> ${j.teacher_reply}</div>` : ''}
            </div>
          `).join('')}
        `;
      } catch (e) {}
    }
  };

  // ==========================================
  // 16. REPORTS MODULE
  // ==========================================
  const Reports = {
    radarChart: null,
    donutChart: null,

    async load() {
      try {
        const overview = await API.call("report.getOverview");
        const issues = await API.call("report.getAttentionIssues");

        const issuesBox = document.getElementById("report-attention-list");
        if (issues.length === 0) {
          issuesBox.innerHTML = "<p style='color:var(--jade-green); font-size:13.5px;'>Học sinh tiếp thu bài rất tốt, chưa phát hiện lỗ hổng ngữ pháp nghiêm trọng.</p>";
        } else {
          issuesBox.innerHTML = issues.map(iss => `
            <div style="padding:12px 16px; background:var(--primary-light); border-left:4px solid var(--primary); border-radius:4px; margin-bottom:10px; font-size:13.5px;">
              <strong>[${iss.type}]</strong> Cần sửa: <span style="text-decoration:line-through; color:var(--danger);">${iss.wrongContent}</span> → <strong style="color:var(--success);">${iss.correctContent}</strong>
              <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">Ghi chú Lão Sư: ${iss.explanation}</div>
            </div>
          `).join('');
        }

        const ctxRadar = document.getElementById("chart-skills-radar").getContext("2d");
        if (this.radarChart) this.radarChart.destroy();
        this.radarChart = new Chart(ctxRadar, {
          type: "radar",
          data: {
            labels: ["Ngữ pháp", "Từ vựng", "Phát âm", "Đọc hiểu", "Viết Hán tự"],
            datasets: [{
              label: "Mức độ thành thạo (%)",
              data: [82, 89, 76, 85, 78],
              backgroundColor: "rgba(184, 53, 40, 0.2)",
              borderColor: "#B83528",
              pointBackgroundColor: "#B83528"
            }]
          },
          options: {
            scales: { r: { min: 0, max: 100 } },
            plugins: { legend: { display: false } }
          }
        });

        const ctxDonut = document.getElementById("chart-completion-donut").getContext("2d");
        if (this.donutChart) this.donutChart.destroy();
        this.donutChart = new Chart(ctxDonut, {
          type: "doughnut",
          data: {
            labels: ["Đã hoàn thành", "Chưa hoàn thành"],
            datasets: [{
              data: [overview.submittedCount, Math.max(0, overview.totalAssignments - overview.submittedCount)],
              backgroundColor: ["#2C6E59", "#EFECE2"]
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
  // 17. UI HELPERS & NOTIFICATIONS
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
  // 18. INITIALIZATION BOOTSTRAP
  // ==========================================
  async function init() {
    Auth.init();
    PinyinEngine.init();
    Router.init();
    Courses.init();
    Assignments.init();
    Grading.init();
    Flashcard.initEvents();
    Dictionary.init();
    Vocabulary.init();
    Journal.init();

    // Khởi tạo cơ sở dữ liệu IndexedDB
    LocalDictionary.init();
  }

  return {
    init,
    UI,
    Utils,
    Router,
    Courses,
    Assignments,
    Grading,
    Flashcard,
    Dictionary,
    Vocabulary,
    ErrorNotebook
  };
})();

// Kích hoạt khi trang đã tải xong DOM
document.addEventListener("DOMContentLoaded", () => {
  App.init();
});
