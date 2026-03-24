    /* ── Config ── */
    const API = 'https://api-xsauyjh24q-du.a.run.app';
    const WS = 'ws_antigravity';
    let _igPendingAccountSelection = null;
    let _igRegisteredAccounts = [];
    let _fbPagePendingSelection = null;
    let _fbRegisteredPages = [];
    let _fbChildPendingSelection = null;
    const DEFAULT_IG_POST_COMMENT_PROMPT = `당신은 Instagram 콘텐츠 분석가입니다.
이메일 리포트의 게시물 표 아래에 붙일 아주 짧은 코멘트 1~2문장만 작성하세요.
반드시 아래 원칙을 지키세요.
- 게시물 내용, 실제 댓글 반응, 성과 지표를 함께 반영
- 최근 1주 전체 게시물 맥락과 비교해 상대적인 위치를 짚어도 좋습니다
- 과장하거나 단정하지 말고 관찰 기반으로 작성
- 댓글이 거의 없으면 댓글 반응이 아직 제한적이라는 점을 자연스럽게 언급
- 표에 이미 숫자가 나오므로 조회수, 댓글수, 참여율 같은 구체적인 숫자를 반복해서 쓰지 마세요
- 대신 이번 기간 중 상위권 반응, 평균 대비 강함/약함, 저장/공유 중심, 댓글 대화 중심 같은 비교형 표현을 우선 사용하세요
- 마크다운, HTML, 이모지, 따옴표 없이 순수 텍스트만 출력
    - 120자 안팎의 짧은 한국어 코멘트로 작성`;
    const IG_PERFORMANCE_MODELS = [
      { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini' },
      { value: 'google/gemini-3-flash-preview', label: 'Gemini Flash 3' },
      { value: 'google/gemini-3.1-flash-lite-preview', label: 'Gemini Flash 3.1 Lite' },
    ];
    const FB_ANALYSIS_MODELS = [
      { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini' },
      { value: 'google/gemini-3-flash-preview', label: 'Gemini Flash 3' },
      { value: 'google/gemini-3.1-flash-lite-preview', label: 'Gemini Flash 3.1 Lite' },
    ];
    const NL_ANALYSIS_MODELS = [
      { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini' },
      { value: 'google/gemini-3-flash-preview', label: 'Gemini Flash 3' },
      { value: 'google/gemini-3.1-flash-lite-preview', label: 'Gemini Flash 3.1 Lite' },
    ];
    const DC_ANALYSIS_MODELS = [
      { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini' },
      { value: 'google/gemini-3-flash-preview', label: 'Gemini Flash 3' },
      { value: 'google/gemini-3.1-flash-lite-preview', label: 'Gemini Flash 3.1 Lite' },
    ];

    /* ── Chip Input ── */
    let chipInputKo = null;
    let chipInputEn = null;

    class ChipInput {
      constructor(containerId) {
        this.container  = document.getElementById(containerId);
        this.chipList   = this.container.querySelector('.chip-list');
        this.textInput  = this.container.querySelector('.chip-text-input');
        this.countBadge = this.container.querySelector('.chip-count');
        this.emails = [];
        this._boundKeydown = this._onKeydown.bind(this);
        this._boundInput   = this._onInput.bind(this);
        this._boundPaste   = this._onPaste.bind(this);
        this._boundClick   = () => this.textInput.focus();
        this.chipList.innerHTML = '';
        this.countBadge.classList.add('hidden');
        this._bindEvents();
      }

      _bindEvents() {
        this.container.addEventListener('click', this._boundClick);
        this.textInput.addEventListener('keydown', this._boundKeydown);
        this.textInput.addEventListener('input',   this._boundInput);
        this.textInput.addEventListener('paste',   this._boundPaste);
      }

      _onKeydown(e) {
        if ((e.key === 'Enter' || e.key === ',') && this.textInput.value.trim()) {
          e.preventDefault();
          this._addEmail(this.textInput.value.replace(/,/g, '').trim());
          this.textInput.value = '';
        } else if (e.key === 'Backspace' && this.textInput.value === '' && this.emails.length > 0) {
          this._removeAt(this.emails.length - 1);
        }
      }

      _onInput() {
        if (this.textInput.value.endsWith(',')) {
          const val = this.textInput.value.slice(0, -1).trim();
          if (val) this._addEmail(val);
          this.textInput.value = '';
        }
      }

      _onPaste(e) {
        e.preventDefault();
        const text = e.clipboardData.getData('text');
        text.split(/[\n\r\t,]+/)
          .map(s => s.trim())
          .filter(Boolean)
          .forEach(s => this._addEmail(s));
        this.textInput.value = '';
      }

      _isValid(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
      }

      _addEmail(raw) {
        const email = raw.toLowerCase();
        if (!email || this.emails.includes(email)) return;
        this.emails.push(email);
        this._renderChip(email);
        this._syncCount();
      }

      _renderChip(email) {
        const valid = this._isValid(email);
        const chip  = document.createElement('div');
        chip.className = 'chip-tag' + (valid ? '' : ' chip-tag--invalid');
        chip.innerHTML =
          `<span class="chip-label" title="${escapeHtml(email)}">${escapeHtml(email)}</span>` +
          `<button class="chip-tag-remove" type="button" aria-label="삭제">✕</button>`;
        chip.querySelector('.chip-tag-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = this.emails.indexOf(email);
          if (idx > -1) this._removeAt(idx);
        });
        this.chipList.appendChild(chip);
      }

      _removeAt(index) {
        this.emails.splice(index, 1);
        this._rerender();
        this._syncCount();
      }

      _rerender() {
        this.chipList.innerHTML = '';
        this.emails.forEach(e => this._renderChip(e));
      }

      _syncCount() {
        const n = this.emails.length;
        if (n === 0) {
          this.countBadge.classList.add('hidden');
        } else {
          this.countBadge.textContent = `${n}명`;
          this.countBadge.classList.remove('hidden');
        }
      }

      setEmails(arr) {
        this.emails = [];
        this.chipList.innerHTML = '';
        (arr || []).forEach(e => this._addEmail(e));
      }

      getEmails() {
        const pending = this.textInput.value.trim();
        if (pending) {
          this._addEmail(pending);
          this.textInput.value = '';
        }
        return [...this.emails];
      }

      hasInvalidEmails() {
        return this.emails.some(e => !this._isValid(e));
      }

      destroy() {
        this.container.removeEventListener('click', this._boundClick);
        this.textInput.removeEventListener('keydown', this._boundKeydown);
        this.textInput.removeEventListener('input',   this._boundInput);
        this.textInput.removeEventListener('paste',   this._boundPaste);
      }
    }

    /* ── Summary 포맷터: 구버전 [섹션] 텍스트 → HTML 변환 ── */
    function formatSummary(text) {
      if (!text) return '—';
      // 이미 HTML인 경우 그대로 반환 (AI 생성 HTML)
      if (text.includes('<br>') || text.includes('<strong>')) return DOMPurify.sanitize(text);
      // [섹션명] 패턴을 줄바꿈 + 볼드로 변환
      const html = text
        .replace(/\[([^\]]+)\]/g, (_, label) => `<br><br><strong>[${label}]</strong>`)
        .replace(/^<br><br>/, ''); // 첫 번째 불필요한 줄바꿈 제거
      return DOMPurify.sanitize(html);
    }

    /* ── Auth ── */
    let secret = '';

    function doLogin() {
      const v = document.getElementById('secretInput').value.trim();
      if (!v) return;
      secret = v;
      sessionStorage.setItem('sl_secret', v);
      closeOverlay();
      initApp();
    }
    function closeOverlay() { document.getElementById('overlay').classList.add('hidden'); }
    document.getElementById('secretInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

    /* ── Flatpickr: 가용 날짜 기반 날짜 비활성화 ── */
    let _fpDatePicker = null, _fpWeekStart = null;
    let _fpAnalyticsStart = null, _fpAnalyticsEnd = null;
    let _fpIgDatePicker = null, _fpIgAnalyticsStart = null, _fpIgAnalyticsEnd = null;
    let _fpFbDatePicker = null;
    let _fpFbPageDatePicker = null;
    let _fpNlDatePicker = null;
    let _fpDcDatePicker = null;
    let _availableFbPageDates = [];
    let _availableNlDates = [];
    let _availableDcDates = [];
    let _availableDailyDates = [], _availableWeeklyDates = [], _availableIgDates = [];
    let _selectedWeekMonday = null; // 주간 picker: 선택된 주의 월요일

    async function initAvailableDates() {
      try {
        const [daily, weekly, ig, fbPage, nl, dc] = await Promise.all([
          apiFetch(`/available-dates?workspaceId=${WS}&type=daily`),
          apiFetch(`/available-dates?workspaceId=${WS}&type=weekly`),
          apiFetch(`/instagram/available-dates?workspaceId=${WS}`),
          apiFetch(`/facebook/page/available-dates?workspaceId=${WS}`),
          apiFetch(`/naver/available-dates?workspaceId=${WS}`),
          apiFetch(`/dcinside/available-dates?workspaceId=${WS}`),
        ]);
        _availableDailyDates  = daily.dates  || [];
        _availableWeeklyDates = weekly.dates || [];
        _availableIgDates     = ig.dates     || [];
        _availableFbPageDates = fbPage.dates || [];
        _availableNlDates     = nl.dates     || [];
        _availableDcDates     = dc.dates     || [];
      } catch (e) {
        console.warn('[available-dates] 로드 실패, 날짜 제한 없이 동작:', e.message);
      }
      initFlatpickrs();
    }

    async function refreshIgAvailableDates() {
      try {
        const ig = await apiFetch(`/instagram/available-dates?workspaceId=${WS}`);
        const newDates = ig.dates || [];
        if (!newDates.length || newDates.join() === _availableIgDates.join()) return;
        _availableIgDates = newDates;
        if (_fpIgDatePicker) _fpIgDatePicker.set('enable', newDates);
      } catch (e) { /* silent */ }
    }

    function ensureIgAnalyticsRange() {
      const $start = document.getElementById('igAnalyticsStartDate');
      const $end = document.getElementById('igAnalyticsEndDate');
      if (!$start || !$end || ($start.value && $end.value)) return;

      const fallbackEnd = new Date(Date.now() + 9 * 60 * 60 * 1000 - 86400000);
      const endDate = _availableIgDates[0] || fallbackEnd.toISOString().split('T')[0];
      const endMs = new Date(endDate + 'T00:00:00+09:00').getTime();
      const windowStartMs = endMs - 29 * 86400000;
      let startDate = endDate;

      for (let i = _availableIgDates.length - 1; i >= 0; i--) {
        const candidate = _availableIgDates[i];
        const candidateMs = new Date(candidate + 'T00:00:00+09:00').getTime();
        if (candidateMs >= windowStartMs && candidateMs <= endMs) {
          startDate = candidate;
          break;
        }
      }

      if (!_availableIgDates.length) {
        const startFallback = new Date(endMs - 29 * 86400000).toISOString().split('T')[0];
        startDate = startFallback;
      }

      if (!$start.value) {
        if (_fpIgAnalyticsStart) _fpIgAnalyticsStart.setDate(startDate, false);
        else $start.value = startDate;
      }
      if (!$end.value) {
        if (_fpIgAnalyticsEnd) _fpIgAnalyticsEnd.setDate(endDate, false);
        else $end.value = endDate;
      }
    }

    function initFlatpickrs() {
      const maxDate = new Date(Date.now() + 9 * 3_600_000).toISOString().split('T')[0];

      // 일요일 빨간색 (모든 picker 공통)
      const onDayCreateBase = (dObj, dStr, fp, dayElem) => {
        if (dayElem.dateObj.getDay() === 0) dayElem.classList.add('fp-sunday');
      };

      // enable 배열이 비어있으면 옵션 자체를 생략 (null 전달 시 Flatpickr 내부 오류 발생)
      const makeOpts = (dates, extra = {}) => {
        const base = { dateFormat: 'Y-m-d', maxDate, locale: { firstDayOfWeek: 1 }, onDayCreate: onDayCreateBase, ...extra };
        if (dates.length) base.enable = dates;
        return base;
      };

      _fpDatePicker = flatpickr('#datePicker', makeOpts(_availableDailyDates, {
        onChange([d]) { if (d) loadReport(); },
      }));

      // ── 주간 picker: 어느 요일 클릭 → 해당 주(월~일) 전체 하이라이트 + 월요일 스냅 ──
      // 가용 주간 날짜(월요일)를 7일 전체로 확장해 어느 요일이든 클릭 가능
      const expandedWeekDates = [];
      _availableWeeklyDates.forEach(mondayStr => {
        const mon = new Date(mondayStr + 'T00:00:00');
        for (let i = 0; i < 7; i++) {
          const d = new Date(mon);
          d.setDate(mon.getDate() + i);
          expandedWeekDates.push(d.toISOString().split('T')[0]);
        }
      });

      _fpWeekStart = flatpickr('#weekStartInput', {
        dateFormat: 'Y-m-d',
        maxDate,
        locale: { firstDayOfWeek: 1 },
        ...(expandedWeekDates.length ? { enable: expandedWeekDates } : {}),
        onDayCreate(dObj, dStr, fp, dayElem) {
          const d = dayElem.dateObj;
          if (d.getDay() === 0) dayElem.classList.add('fp-sunday');
          if (_selectedWeekMonday) {
            const mon = new Date(_selectedWeekMonday); mon.setHours(0, 0, 0, 0);
            const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
            const day = new Date(d); day.setHours(0, 0, 0, 0);
            if (day >= mon && day <= sun) {
              dayElem.classList.add('fp-week-sel');
              if (day.getTime() === mon.getTime()) dayElem.classList.add('fp-week-start');
              if (day.getTime() === sun.getTime()) dayElem.classList.add('fp-week-end');
            }
          }
        },
        onChange([d], dateStr, fp) {
          if (!d) return;
          const dow = d.getDay(); // 0=일, 1=월 … 6=토
          const diff = dow === 0 ? -6 : 1 - dow; // 월요일까지의 차이
          const monday = new Date(d);
          monday.setDate(d.getDate() + diff);
          _selectedWeekMonday = new Date(monday);
          fp.setDate(monday, false); // 월요일로 스냅 (onChange 재발동 없음)
          fp.redraw();               // 주간 하이라이트 갱신
          loadWeeklyReport();
        },
      });

      _fpAnalyticsStart = flatpickr('#analyticsStartDate', makeOpts(_availableDailyDates));
      _fpAnalyticsEnd   = flatpickr('#analyticsEndDate',   makeOpts(_availableDailyDates));
      _fpIgDatePicker   = flatpickr('#igDatePicker', makeOpts(_availableIgDates, {
        onChange([d]) { if (d) loadIgReport(); },
      }));
      _fpIgAnalyticsStart = flatpickr('#igAnalyticsStartDate', {
        dateFormat: 'Y-m-d',
        maxDate,
        locale: { firstDayOfWeek: 1 },
        onDayCreate: onDayCreateBase,
      });
      _fpIgAnalyticsEnd = flatpickr('#igAnalyticsEndDate', {
        dateFormat: 'Y-m-d',
        maxDate,
        locale: { firstDayOfWeek: 1 },
        onDayCreate: onDayCreateBase,
      });

      _fpFbDatePicker = flatpickr('#fbReportDate', {
        dateFormat: 'Y-m-d',
        maxDate,
        locale: { firstDayOfWeek: 1 },
        onDayCreate: onDayCreateBase,
        onChange([d]) { if (d) loadFbReport(); },
      });

      _fpFbPageDatePicker = flatpickr('#fbPageReportDate', {
        dateFormat: 'Y-m-d',
        maxDate,
        locale: { firstDayOfWeek: 1 },
        onDayCreate: onDayCreateBase,
        onChange([d]) { if (d) loadFbPageReport(); },
      });
      if (_availableFbPageDates.length) {
        _fpFbPageDatePicker.set('enable', _availableFbPageDates);
        if (!_fpFbPageDatePicker.selectedDates.length) _fpFbPageDatePicker.setDate(_availableFbPageDates[0], false);
      }

      _fpNlDatePicker = flatpickr('#nlReportDate', {
        dateFormat: 'Y-m-d',
        maxDate,
        locale: { firstDayOfWeek: 1 },
        onDayCreate: onDayCreateBase,
        onChange([d]) { if (d) loadNlReport(); },
      });
      if (_availableNlDates.length) {
        _fpNlDatePicker.set('enable', _availableNlDates);
        if (!_fpNlDatePicker.selectedDates.length) _fpNlDatePicker.setDate(_availableNlDates[0], false);
      }

      _fpDcDatePicker = flatpickr('#dcReportDate', {
        dateFormat: 'Y-m-d',
        maxDate,
        locale: { firstDayOfWeek: 1 },
        onDayCreate: onDayCreateBase,
        onChange([d]) { if (d) loadDcReport(); },
      });
      if (_availableDcDates.length) {
        _fpDcDatePicker.set('enable', _availableDcDates);
        if (!_fpDcDatePicker.selectedDates.length) _fpDcDatePicker.setDate(_availableDcDates[0], false);
      }
    }

    /* ── Init ── */
    window.addEventListener('DOMContentLoaded', () => {
      const kst = new Date(Date.now() + 9 * 3_600_000);
      const today = kst.toISOString().split('T')[0];
      document.getElementById('datePicker').value = today;

      const stored = sessionStorage.getItem('sl_secret');
      if (stored) { secret = stored; closeOverlay(); initApp(); }
    });

    function initApp() {
      switchView('landing');
      initAvailableDates();
      checkFbSessionAlert();
      checkNlSessionAlert();
      checkDcSessionAlert();
    }

    async function checkFbSessionAlert() {
      try {
        const status = await apiFetch(`/facebook/session/status?workspaceId=${WS}`);
        const show = status.exists && !status.isValid;
        const $dot = document.getElementById('fb-session-alert');
        if ($dot) $dot.style.display = show ? 'inline-block' : 'none';
      } catch (_) {}
    }

    /* ── View switching ── */
    let currentView = 'landing';
    let _reportLang = 'ko'; // 'ko' | 'en'

    /* ── Guild filter cache ── */
    let _reportAllGuilds = [];
    let _weeklyAllGuilds = [];
    let _alertAllChannels = [];
    let _igAnalyticsAccounts = [];
    let _igReportAllAccounts = [];

    function togglePlatform(rowEl) {
      const section = rowEl.closest('.platform-section');
      if (!section.querySelector('.sub-nav')) return;
      section.classList.toggle('open');
    }

    function switchView(view) {
      currentView = view;

      // 해당 nav 아이템의 상위 플랫폼 섹션이 닫혀있으면 자동으로 열기
      const viewToNavId = {
        'report': 'nav-report', 'weekly': 'nav-weekly', 'analytics': 'nav-analytics',
        'channels': 'nav-channels', 'data': 'nav-data', 'alert': 'nav-alert',
        'ig-report': 'nav-ig-report', 'ig-analytics': 'nav-ig-analytics',
        'ig-accounts': 'nav-ig-accounts', 'ig-tokens': 'nav-ig-tokens',
        'fb-report': 'nav-fb-report', 'fb-groups': 'nav-fb-groups',
        'fb-page-report': 'nav-fb-page-report', 'fb-pages': 'nav-fb-pages',
        'fb-session': 'nav-fb-session',
        'nl-report': 'nav-nl-report', 'nl-lounges': 'nav-nl-lounges', 'nl-session': 'nav-nl-session',
        'dc-report': 'nav-dc-report', 'dc-galleries': 'nav-dc-galleries', 'dc-session': 'nav-dc-session',
        'preset-mgmt': 'nav-preset-mgmt',
        'delivery-log': 'nav-delivery-log',
      };
      const navId = viewToNavId[view];
      if (navId) {
        const navEl = document.getElementById(navId);
        if (navEl) {
          const section = navEl.closest('.platform-section');
          if (section && !section.classList.contains('open')) section.classList.add('open');
        }
      }

      // Sub-nav active state
      document.getElementById('nav-report').classList.toggle('active', view === 'report');
      document.getElementById('nav-weekly').classList.toggle('active', view === 'weekly');
      document.getElementById('nav-analytics').classList.toggle('active', view === 'analytics');
      document.getElementById('nav-channels').classList.toggle('active', view === 'channels');
      document.getElementById('nav-data').classList.toggle('active', view === 'data');
      document.getElementById('nav-alert').classList.toggle('active', view === 'alert');
      document.getElementById('nav-ig-report').classList.toggle('active', view === 'ig-report');
      document.getElementById('nav-ig-analytics').classList.toggle('active', view === 'ig-analytics');
      document.getElementById('nav-ig-accounts').classList.toggle('active', view === 'ig-accounts');
      document.getElementById('nav-ig-tokens').classList.toggle('active', view === 'ig-tokens');
      document.getElementById('nav-fb-report').classList.toggle('active', view === 'fb-report');
      document.getElementById('nav-fb-groups').classList.toggle('active', view === 'fb-groups');
      document.getElementById('nav-fb-page-report').classList.toggle('active', view === 'fb-page-report');
      document.getElementById('nav-fb-pages').classList.toggle('active', view === 'fb-pages');
      document.getElementById('nav-fb-session').classList.toggle('active', view === 'fb-session');
      document.getElementById('nav-nl-report').classList.toggle('active', view === 'nl-report');
      document.getElementById('nav-nl-lounges').classList.toggle('active', view === 'nl-lounges');
      document.getElementById('nav-nl-session').classList.toggle('active', view === 'nl-session');
      document.getElementById('nav-dc-report').classList.toggle('active', view === 'dc-report');
      document.getElementById('nav-dc-galleries').classList.toggle('active', view === 'dc-galleries');
      document.getElementById('nav-dc-session').classList.toggle('active', view === 'dc-session');
      document.getElementById('nav-preset-mgmt').classList.toggle('active', view === 'preset-mgmt');
      document.getElementById('nav-delivery-log').classList.toggle('active', view === 'delivery-log');

      // Topbars
      document.getElementById('topbar-report').classList.toggle('hidden', view !== 'report');
      document.getElementById('topbar-weekly').classList.toggle('hidden', view !== 'weekly');
      document.getElementById('topbar-analytics').classList.toggle('hidden', view !== 'analytics');
      document.getElementById('topbar-channels').classList.toggle('hidden', view !== 'channels');
      document.getElementById('topbar-data').classList.toggle('hidden', view !== 'data');
      document.getElementById('topbar-alert').classList.toggle('hidden', view !== 'alert');
      document.getElementById('topbar-ig-report').classList.toggle('hidden', view !== 'ig-report');
      document.getElementById('topbar-ig-analytics').classList.toggle('hidden', view !== 'ig-analytics');
      document.getElementById('topbar-ig-accounts').classList.toggle('hidden', view !== 'ig-accounts');
      document.getElementById('topbar-ig-tokens').classList.toggle('hidden', view !== 'ig-tokens');
      document.getElementById('topbar-fb-report').classList.toggle('hidden', view !== 'fb-report');
      document.getElementById('topbar-fb-groups').classList.toggle('hidden', view !== 'fb-groups');
      document.getElementById('topbar-fb-page-report').classList.toggle('hidden', view !== 'fb-page-report');
      document.getElementById('topbar-fb-pages').classList.toggle('hidden', view !== 'fb-pages');
      document.getElementById('topbar-fb-session').classList.toggle('hidden', view !== 'fb-session');
      document.getElementById('topbar-nl-report').classList.toggle('hidden', view !== 'nl-report');
      document.getElementById('topbar-nl-lounges').classList.toggle('hidden', view !== 'nl-lounges');
      document.getElementById('topbar-nl-session').classList.toggle('hidden', view !== 'nl-session');
      document.getElementById('topbar-dc-report').classList.toggle('hidden', view !== 'dc-report');
      document.getElementById('topbar-dc-galleries').classList.toggle('hidden', view !== 'dc-galleries');
      document.getElementById('topbar-dc-session').classList.toggle('hidden', view !== 'dc-session');
      document.getElementById('topbar-preset-mgmt').classList.toggle('hidden', view !== 'preset-mgmt');
      document.getElementById('topbar-delivery-log').classList.toggle('hidden', view !== 'delivery-log');

      // Views
      document.getElementById('view-landing').classList.toggle('hidden', view !== 'landing');
      document.getElementById('view-report').classList.toggle('hidden', view !== 'report');
      document.getElementById('view-weekly').classList.toggle('hidden', view !== 'weekly');
      document.getElementById('view-analytics').classList.toggle('hidden', view !== 'analytics');
      document.getElementById('view-channels').classList.toggle('hidden', view !== 'channels');
      document.getElementById('view-data').classList.toggle('hidden', view !== 'data');
      document.getElementById('view-alert').classList.toggle('hidden', view !== 'alert');
      document.getElementById('view-ig-report').classList.toggle('hidden', view !== 'ig-report');
      document.getElementById('view-ig-analytics').classList.toggle('hidden', view !== 'ig-analytics');
      document.getElementById('view-ig-accounts').classList.toggle('hidden', view !== 'ig-accounts');
      document.getElementById('view-ig-tokens').classList.toggle('hidden', view !== 'ig-tokens');
      document.getElementById('view-fb-report').classList.toggle('hidden', view !== 'fb-report');
      document.getElementById('view-fb-groups').classList.toggle('hidden', view !== 'fb-groups');
      document.getElementById('view-fb-page-report').classList.toggle('hidden', view !== 'fb-page-report');
      document.getElementById('view-fb-pages').classList.toggle('hidden', view !== 'fb-pages');
      document.getElementById('view-fb-session').classList.toggle('hidden', view !== 'fb-session');
      document.getElementById('view-nl-report').classList.toggle('hidden', view !== 'nl-report');
      document.getElementById('view-nl-lounges').classList.toggle('hidden', view !== 'nl-lounges');
      document.getElementById('view-nl-session').classList.toggle('hidden', view !== 'nl-session');
      document.getElementById('view-dc-report').classList.toggle('hidden', view !== 'dc-report');
      document.getElementById('view-dc-galleries').classList.toggle('hidden', view !== 'dc-galleries');
      document.getElementById('view-dc-session').classList.toggle('hidden', view !== 'dc-session');
      document.getElementById('view-preset-mgmt').classList.toggle('hidden', view !== 'preset-mgmt');
      document.getElementById('view-delivery-log').classList.toggle('hidden', view !== 'delivery-log');

      if (view === 'report') loadReport();
      if (view === 'channels') loadChannels();
      if (view === 'data') loadDataLogs();
      if (view === 'alert') loadAlertMonitor();
      if (view === 'ig-report') { refreshIgAvailableDates(); loadIgReport(); }
      if (view === 'ig-analytics') {
        refreshIgAvailableDates();
        ensureIgAnalyticsRange();
        loadIgAnalytics();
      }
      if (view === 'ig-accounts') loadIgAccounts();
      if (view === 'ig-tokens') loadIgTokens();
      if (view === 'fb-report') { refreshFbAvailableDates().then(() => loadFbReport()); }
      if (view === 'fb-groups') loadFbGroups();
      if (view === 'fb-page-report') { refreshFbPageAvailableDates().then(() => loadFbPageReport()); }
      if (view === 'fb-pages') loadFbPages();
      if (view === 'fb-session') loadFbSession();
      if (view === 'nl-report') { refreshNlAvailableDates().then(() => loadNlReport()); }
      if (view === 'nl-lounges') loadNlLounges();
      if (view === 'nl-session') loadNlSession();
      if (view === 'dc-report') { refreshDcAvailableDates().then(() => loadDcReport()); }
      if (view === 'dc-galleries') loadDcGalleries();
      if (view === 'dc-session') loadDcSession();
      if (view === 'preset-mgmt') loadPresets();
      if (view === 'delivery-log') loadDeliveryLog();
      if (view === 'weekly') {
        // 이번 주 월요일 기본값 세팅
        const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const day = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() - (day - 1));
        const monday = d.toISOString().split('T')[0];
        if (_fpWeekStart) _fpWeekStart.setDate(monday, true);
        else document.getElementById('weekStartInput').value = monday;
        loadWeeklyReport();
      }
      if (view === 'analytics') {
        // 시작일: KST 30일 전 / 종료일: KST 어제
        const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const yesterday = new Date(kstNow); yesterday.setUTCDate(kstNow.getUTCDate() - 1);
        const monthAgo  = new Date(kstNow); monthAgo.setUTCDate(kstNow.getUTCDate() - 30);
        const fmt = d => d.toISOString().split('T')[0];
        const $s = document.getElementById('analyticsStartDate');
        const $e = document.getElementById('analyticsEndDate');
        if (!$s.value) { if (_fpAnalyticsStart) _fpAnalyticsStart.setDate(fmt(monthAgo), true); else $s.value = fmt(monthAgo); }
        if (!$e.value) { if (_fpAnalyticsEnd)   _fpAnalyticsEnd.setDate(fmt(yesterday),  true); else $e.value = fmt(yesterday); }
        loadAnalytics();
      }
    }

    /* ══════════════════════════════════════
       REPORT VIEW
    ══════════════════════════════════════ */
    async function loadReport() {
      const date = document.getElementById('datePicker').value;
      const $main = document.getElementById('report-main');
      const $btn = document.getElementById('refreshBtn');

      $btn.classList.add('spinning');
      $main.innerHTML = skeletonHTML();

      try {
        const r = await apiFetch(`/report?workspaceId=${WS}&date=${date}`);
        _reportAllGuilds = r.guilds || [];
        populateReportGuildDropdown(_reportAllGuilds);
        renderReportView(date);
      } catch (err) {
        handleApiError(err, $main);
      } finally {
        $btn.classList.remove('spinning');
      }
    }

    function populateReportGuildDropdown(guilds) {
      const $sel = document.getElementById('reportGuildFilter');
      const prev = $sel.value;
      $sel.innerHTML = '<option value="all">전체</option>' +
        guilds.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.guildName || g.id)}</option>`).join('');
      if ([...$sel.options].some(o => o.value === prev)) $sel.value = prev;
    }

    function filterReportGuild() {
      renderReportView(document.getElementById('datePicker').value);
    }

    function toggleReportLang() {
      _reportLang = _reportLang === 'ko' ? 'en' : 'ko';
      const lbl = _reportLang.toUpperCase();
      document.getElementById('langToggleBtn').textContent = lbl;
      document.getElementById('langToggleBtnWeekly').textContent = lbl;
      renderReportView(document.getElementById('datePicker').value);
    }

    function toggleReportLangWeekly() {
      _reportLang = _reportLang === 'ko' ? 'en' : 'ko';
      const lbl = _reportLang.toUpperCase();
      document.getElementById('langToggleBtn').textContent = lbl;
      document.getElementById('langToggleBtnWeekly').textContent = lbl;
      renderWeeklyView(document.getElementById('weekStartInput').value);
    }

    function renderReportView(date) {
      const $main = document.getElementById('report-main');
      const filterVal = document.getElementById('reportGuildFilter').value;
      const guilds = filterVal === 'all'
        ? _reportAllGuilds
        : _reportAllGuilds.filter(g => g.id === filterVal);

      if (!guilds.length) {
        $main.innerHTML = emptyHTML(date);
      } else {
        $main.innerHTML = dashHTML({ date, guilds });
        requestAnimationFrame(() => requestAnimationFrame(() => {
          $main.querySelectorAll('.sent-seg[data-v]').forEach(el => { el.style.width = el.dataset.v + '%'; });
          $main.querySelectorAll('.stat-val[data-target]').forEach(el => { countUp(el, +el.dataset.target, el.dataset.suffix || ''); });
        }));
      }
    }

    /* ══════════════════════════════════════
       CHANNEL MANAGEMENT VIEW
    ══════════════════════════════════════ */
    async function loadChannels() {
      const $list = document.getElementById('channelList');
      const $count = document.getElementById('listCount');
      $list.innerHTML = `<div class="sk sk--sm"></div>`.repeat(3);

      try {
        const { channels } = await apiFetch(`/channels?workspaceId=${WS}`);
        $count.textContent = channels.length;

        if (!channels.length) {
          $list.innerHTML = `
          <div class="ch-empty">
            <div style="display:flex;justify-content:center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                <path d="M8 10h8M8 14h5" opacity=".4"/>
              </svg>
            </div>
            <div style="margin-top:.875rem;font-weight:600;color:var(--text)">등록된 채널 없음</div>
            <div>왼쪽 폼에서 첫 번째 채널을 추가해 보세요.</div>
          </div>`;
          return;
        }

        // Group channels by discordGuildId
        const groupMap = {};
        channels.forEach(ch => {
          const gid = ch.discordGuildId || 'unknown';
          if (!groupMap[gid]) groupMap[gid] = { guildId: gid, guildName: null, channels: [] };
          groupMap[gid].channels.push(ch);
        });

        // Fetch guild names in parallel
        await Promise.all(Object.values(groupMap).map(async g => {
          if (g.guildId && g.guildId !== 'unknown') {
            try {
              const info = await apiFetch(`/guild?guildId=${g.guildId}`);
              g.guildName = info.name;
            } catch (_) { g.guildName = null; }
          }
        }));

        $list.innerHTML = Object.values(groupMap).map(g => guildGroupHTML(g)).join('');
      } catch (err) {
        $list.innerHTML = `<div class="state-wrap"><div class="state-icon error">${SVG.warn}</div><div class="state-title">불러오기 실패</div><div class="state-desc">${escapeHtml(err.message)}</div></div>`;
      }
    }

    async function addChannel() {
      const guildId = document.getElementById('inputGuildId').value.trim();
      const channelId = document.getElementById('inputChannelId').value.trim();
      const $result = document.getElementById('addResult');
      const $btn = document.getElementById('addBtn');

      if (!channelId) {
        $result.className = 'add-result err';
        $result.textContent = '채널 ID를 입력해 주세요.';
        return;
      }

      $btn.disabled = true;
      $btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin .75s linear infinite"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 조회 중...`;
      $result.className = 'add-result';
      $result.textContent = '';

      try {
        const res = await apiFetch('/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, guildId: guildId || undefined, channelId }),
        });
        $result.className = 'add-result ok';
        $result.textContent = `✓ #${res.channelName} 채널이 추가되었습니다.`;
        document.getElementById('inputGuildId').value = '';
        document.getElementById('inputChannelId').value = '';
        loadChannels();
      } catch (err) {
        $result.className = 'add-result err';
        $result.textContent = err.message;
      } finally {
        $btn.disabled = false;
        $btn.innerHTML = `${SVG.plus} 채널 추가`;
      }
    }

    async function toggleChannel(docId, currentActive) {
      try {
        await apiFetch(`/channels?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !currentActive }),
        });
        loadChannels();
      } catch (err) {
        alert('변경 실패: ' + err.message);
      }
    }

    async function deleteChannel(docId, channelName) {
      if (!confirm(`#${channelName} 채널을 삭제하시겠습니까?\n\n삭제하면 해당 채널의 수집이 중단됩니다.`)) return;
      try {
        await apiFetch(`/channels?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'DELETE',
        });
        loadChannels();
      } catch (err) {
        alert('삭제 실패: ' + err.message);
      }
    }

    async function resetChannelData(docId, channelName) {
      if (!confirm(
        `#${channelName} 채널의 수집 데이터를 초기화하시겠습니까?\n\n` +
        `• 수집된 메시지 청크 전체 삭제\n` +
        `• 수집 로그 삭제\n` +
        `• 다음 수집 시 오늘 0시부터 재수집 시작\n\n` +
        `이 작업은 되돌릴 수 없습니다.`
      )) return;
      try {
        const res = await apiFetch(
          `/channels/reset?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`,
          { method: 'POST' }
        );
        alert(`✓ 초기화 완료\n청크 ${res.deleted.chunks}개, 수집 로그 ${res.deleted.logs}개 삭제됨\n다음 수집부터 오늘 0시 기준으로 재시작합니다.`);
        loadChannels();
      } catch (err) {
        alert('초기화 실패: ' + err.message);
      }
    }

    function guildGroupHTML(group) {
      const guildDocId = 'discord_' + group.guildId;
      return `
      <div class="guild-group">
        <div class="guild-group-header">
          <div class="guild-group-icon">${SVG.discord}</div>
          <div class="guild-group-info">
            <div class="guild-group-name">${escapeHtml(group.guildName || '알 수 없는 서버')}</div>
            <div class="guild-group-id">${escapeHtml(group.guildId)}</div>
          </div>
          <button class="btn-guild-settings"
            data-guild-doc-id="${escapeHtml(guildDocId)}"
            data-guild-name="${escapeHtml(group.guildName || '')}"
            onclick="openGuildSettings(this.dataset.guildDocId, this.dataset.guildName)">서버 설정</button>
          <div class="guild-group-count">${group.channels.length}개</div>
        </div>
        <div class="guild-channels">
          ${group.channels.map(ch => channelRowHTML(ch)).join('')}
        </div>
      </div>`;
    }

    function channelRowHTML(ch) {
      const isActive = ch.isActive !== false;
      const importance = ch.importance || 'normal';
      const panelId = `settings-${ch.docId}`;
      const safeDocId = ch.docId.replace(/'/g, "\\'");
      const impLabels = { low: '낮음', normal: '보통', high: '높음' };

      return `
      <div class="ch-row ${isActive ? '' : 'inactive'}" id="row-${ch.docId}">
        <div class="ch-row-icon">${SVG.discord}</div>
        <div class="ch-row-info">
          <div class="ch-row-name"># ${escapeHtml(ch.channelName || ch.discordChannelId)}</div>
          <div class="ch-row-meta">${escapeHtml(ch.discordChannelId)}</div>
        </div>
        <span class="imp-badge imp-${importance}">${impLabels[importance]}</span>
        <div class="ch-row-status ${isActive ? 'active' : 'inactive'}">${isActive ? '활성' : '비활성'}</div>
        <div class="ch-row-actions">
          <div class="action-btn settings" id="settingsBtn-${ch.docId}"
               onclick="toggleSettings('${safeDocId}')" title="채널 설정">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </div>
          <div class="action-btn ${isActive ? 'toggle-on' : 'toggle-off'}"
               onclick="toggleChannel('${safeDocId}', ${isActive})"
               title="${isActive ? '비활성화' : '활성화'}">
            ${isActive
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728L5.636 5.636"/></svg>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
        }
          </div>
          <div class="action-btn reset"
               data-reset-name="${escapeHtml(ch.channelName || ch.discordChannelId)}"
               onclick="resetChannelData('${safeDocId}', this.dataset.resetName)"
               title="수집 데이터 초기화">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
            </svg>
          </div>
          <div class="action-btn del"
               data-del-name="${escapeHtml(ch.channelName || ch.discordChannelId)}"
               onclick="deleteChannel('${safeDocId}', this.dataset.delName)"
               title="채널 삭제">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </div>
        </div>
      </div>
      <div class="ch-settings-panel" id="${panelId}">
        <!-- 채널 중요도 -->
        <div class="settings-section">
          <div class="settings-section-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            채널 중요도
          </div>
          <div class="imp-toggle-wrap">
            <span class="imp-toggle-label">리포트 상세도를 조절합니다.</span>
            <div class="imp-btn-group">
              <button class="imp-btn${importance === 'low' ? ' active-low' : ''}" data-val="low"    onclick="setImportance('${safeDocId}', 'low')">낮음</button>
              <button class="imp-btn${importance === 'normal' ? ' active-normal' : ''}" data-val="normal" onclick="setImportance('${safeDocId}', 'normal')">보통</button>
              <button class="imp-btn${importance === 'high' ? ' active-high' : ''}" data-val="high"   onclick="setImportance('${safeDocId}', 'high')">높음</button>
            </div>
          </div>
        </div>

        <!-- 맞춤 분석 지시문 -->
        <div class="settings-section">
          <div class="settings-section-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
            맞춤 분석 지시문
          </div>
          <textarea class="settings-textarea" id="prompt-${ch.docId}"
            placeholder="예: 이번 패치 밸런스에 대한 유저 반응을 집중 요약해줘."
          >${(ch.customPrompt || '').replace(/</g, '&lt;')}</textarea>
        </div>

        <div class="settings-save-row">
          <span class="settings-msg" id="settingsMsg-${ch.docId}"></span>
          <button class="btn-save-settings" onclick="saveSettings('${safeDocId}')">저장</button>
        </div>
      </div>`;
    }

    async function setImportance(docId, value) {
      try {
        await apiFetch(`/channels/settings?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ importance: value }),
        });
        const labels = { low: '낮음', normal: '보통', high: '높음' };
        const badge = document.querySelector(`#row-${docId} .imp-badge`);
        if (badge) { badge.className = `imp-badge imp-${value}`; badge.textContent = labels[value]; }
        document.querySelectorAll(`#settings-${docId} .imp-btn`).forEach(btn => {
          btn.classList.remove('active-low', 'active-normal', 'active-high');
        });
        document.querySelector(`#settings-${docId} .imp-btn[data-val="${value}"]`)?.classList.add(`active-${value}`);
      } catch (err) {
        alert('중요도 변경 실패: ' + err.message);
      }
    }

    async function openGuildSettings(guildDocId, guildName) {
      document.getElementById('guildModalTitle').textContent = `${guildName} — 서버 설정`;
      document.getElementById('guildModalDocId').value = guildDocId;
      document.getElementById('guildModalGuildName').value = guildName;
      document.getElementById('guildEmailEnabled').checked = false;
      if (chipInputKo) chipInputKo.destroy();
      if (chipInputEn) chipInputEn.destroy();
      chipInputKo = new ChipInput('guildEmailRecipientsKo');
      chipInputEn = new ChipInput('guildEmailRecipientsEn');
      document.getElementById('guildSheetsEnabled').checked = false;
      document.getElementById('guildSheetsUrl').value = '';
      document.getElementById('guildSummaryPrompt').value = '';
      document.getElementById('guildModalMsg').textContent = '';
      document.getElementById('guildModalMsg').className = 'guild-modal-msg';
      document.getElementById('testEmailKoMsg').textContent = '';
      document.getElementById('testEmailKoMsg').className = 'test-delivery-msg';
      document.getElementById('testEmailEnMsg').textContent = '';
      document.getElementById('testEmailEnMsg').className = 'test-delivery-msg';
      document.getElementById('testSheetsMsg').textContent = '';
      document.getElementById('testSheetsMsg').className = 'test-delivery-msg';
      document.getElementById('guildModalOverlay').classList.remove('hidden');
      try {
        const { guilds } = await apiFetch(`/guilds?workspaceId=${WS}`);
        const guild = guilds.find(g => g.docId === guildDocId);
        if (guild) {
          const dc = guild.deliveryConfig || {};
          const em = dc.email || {};
          const sh = dc.googleSheets || {};
          document.getElementById('guildEmailEnabled').checked = !!em.isEnabled;
          chipInputKo.setEmails(em.recipientsKo || em.recipients || []);
          chipInputEn.setEmails(em.recipientsEn || []);
          document.getElementById('guildSheetsEnabled').checked = !!sh.isEnabled;
          document.getElementById('guildSheetsUrl').value = sh.spreadsheetUrl || '';
          document.getElementById('guildSummaryPrompt').value = guild.summaryPrompt || '';
          const tokenHint = document.getElementById('guildDiscordTokenHint');
          document.getElementById('guildDiscordToken').value = '';
          if (guild.discordUserToken) {
            tokenHint.textContent = `저장된 토큰: ${guild.discordUserToken.slice(0, 10)}...`;
            tokenHint.style.color = '#22c55e';
          } else {
            tokenHint.textContent = '저장된 토큰 없음';
            tokenHint.style.color = '#94a3b8';
          }
        }
      } catch (_) { }
    }

    function closeGuildModal() {
      document.getElementById('guildModalOverlay').classList.add('hidden');
    }

    async function saveGuildSettings() {
      const docId = document.getElementById('guildModalDocId').value;
      const emailOn = document.getElementById('guildEmailEnabled').checked;
      const recipientsKo = chipInputKo ? chipInputKo.getEmails() : [];
      const recipientsEn = chipInputEn ? chipInputEn.getEmails() : [];
      const sheetsOn = document.getElementById('guildSheetsEnabled').checked;
      const sheetsUrl = document.getElementById('guildSheetsUrl').value.trim();
      const summaryPrompt = document.getElementById('guildSummaryPrompt').value.trim();
      const discordToken = document.getElementById('guildDiscordToken').value.trim();
      const $msg = document.getElementById('guildModalMsg');
      const btn = document.querySelector('#guildModalOverlay .btn-save-settings');

      btn.disabled = true;
      $msg.className = 'guild-modal-msg';
      $msg.textContent = '';

      if ((chipInputKo && chipInputKo.hasInvalidEmails()) ||
          (chipInputEn && chipInputEn.hasInvalidEmails())) {
        $msg.className = 'guild-modal-msg err';
        $msg.textContent = '빨간색 이메일 주소를 확인해 주세요.';
        btn.disabled = false;
        return;
      }

      try {
        const updates = {
          deliveryConfig: {
            email: { isEnabled: emailOn, recipientsKo, recipientsEn },
            googleSheets: { isEnabled: sheetsOn, spreadsheetUrl: sheetsUrl },
          },
          summaryPrompt,
        };
        if (discordToken) updates.discordUserToken = discordToken;
        await apiFetch(`/guilds/settings?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        $msg.className = 'guild-modal-msg ok';
        $msg.textContent = '저장됨';
        setTimeout(() => { $msg.textContent = ''; }, 2500);
      } catch (err) {
        $msg.className = 'guild-modal-msg err';
        $msg.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    }

    async function testGuildDelivery(type) {
      const guildName = document.getElementById('guildModalGuildName').value || '테스트 서버';
      const btnId = type === 'email-ko' ? 'testEmailKoBtn' : type === 'email-en' ? 'testEmailEnBtn' : 'testSheetsBtn';
      const msgId = type === 'email-ko' ? 'testEmailKoMsg' : type === 'email-en' ? 'testEmailEnMsg' : 'testSheetsMsg';
      const btn  = document.getElementById(btnId);
      const $msg = document.getElementById(msgId);

      let config;
      if (type === 'email-ko') {
        const recipientsKo = chipInputKo ? chipInputKo.getEmails() : [];
        if (!recipientsKo.length) { $msg.className = 'test-delivery-msg err'; $msg.textContent = '수신자 이메일을 입력하세요.'; return; }
        config = { recipientsKo, lang: 'ko' };
      } else if (type === 'email-en') {
        const recipientsEn = chipInputEn ? chipInputEn.getEmails() : [];
        if (!recipientsEn.length) { $msg.className = 'test-delivery-msg err'; $msg.textContent = 'Please enter recipient email(s).'; return; }
        config = { recipientsEn, lang: 'en' };
      } else {
        const spreadsheetUrl = document.getElementById('guildSheetsUrl').value.trim();
        if (!spreadsheetUrl) { $msg.className = 'test-delivery-msg err'; $msg.textContent = '스프레드시트 URL을 입력하세요.'; return; }
        config = { spreadsheetUrl };
      }

      btn.disabled = true;
      $msg.className = 'test-delivery-msg';
      $msg.textContent = '발송 중…';

      try {
        await apiFetch('/guilds/test-delivery', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guildName, type, config }),
        });
        $msg.className = 'test-delivery-msg ok';
        $msg.textContent = type === 'email-en' ? '✓ Email sent' : type === 'email-ko' ? '✓ 이메일 발송 완료' : '✓ 시트 기록 완료';
      } catch (err) {
        $msg.className = 'test-delivery-msg err';
        $msg.textContent = '✗ ' + err.message;
      } finally {
        btn.disabled = false;
      }
    }

    function toggleSettings(docId) {
      const panel = document.getElementById(`settings-${docId}`);
      const btn = document.getElementById(`settingsBtn-${docId}`);
      const isOpen = panel.classList.toggle('open');
      btn.classList.toggle('open', isOpen);
    }

    async function saveSettings(docId) {
      const customPrompt = document.getElementById(`prompt-${docId}`).value;
      const $msg = document.getElementById(`settingsMsg-${docId}`);

      const btn = document.querySelector(`#settings-${docId} .btn-save-settings`);
      btn.disabled = true;
      $msg.className = 'settings-msg';
      $msg.textContent = '';

      try {
        await apiFetch(`/channels/settings?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customPrompt }),
        });
        $msg.className = 'settings-msg ok';
        $msg.textContent = '저장됨';
        setTimeout(() => { $msg.textContent = ''; }, 2500);
      } catch (err) {
        $msg.className = 'settings-msg err';
        $msg.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    }

    /* ══════════════════════════════════════
       ALERT MONITOR VIEW
    ══════════════════════════════════════ */
    async function loadAlertMonitor() {
      const $main = document.getElementById('alert-monitor-main');
      $main.innerHTML =
        `<div class="sk sk--md"></div>` +
        `<div class="sk" style="height:220px;border-radius:12px;margin-bottom:.875rem"></div>`.repeat(2);

      try {
        const { channels } = await apiFetch(`/channels?workspaceId=${WS}`);
        const discordChs = channels.filter(ch => ch.platform === 'discord');

        if (!discordChs.length) {
          $main.innerHTML = `<div class="state-wrap">
          <div class="state-icon empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
          </div>
          <div class="state-title">Discord 채널 없음</div>
          <div class="state-desc">채널 관리에서 Discord 채널을 먼저 추가해 주세요.</div>
        </div>`;
          return;
        }

        _alertAllChannels = discordChs;
        populateAlertGuildDropdown(discordChs);
        renderAlertView();
      } catch (err) {
        handleApiError(err, $main);
      }
    }

    function populateAlertGuildDropdown(channels) {
      const $sel = document.getElementById('alertGuildFilter');
      const prev = $sel.value;
      const guilds = [...new Map(channels.map(ch => [ch.discordGuildId, ch.guildName || ch.discordGuildId])).entries()];
      $sel.innerHTML = '<option value="all">전체</option>' +
        guilds.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
      if ([...$sel.options].some(o => o.value === prev)) $sel.value = prev;
    }

    function filterAlertGuild() {
      renderAlertView();
    }

    function renderAlertView() {
      const $main = document.getElementById('alert-monitor-main');
      const filterVal = document.getElementById('alertGuildFilter').value;
      const discordChs = filterVal === 'all'
        ? _alertAllChannels
        : _alertAllChannels.filter(ch => ch.discordGuildId === filterVal);

      const enabledCount = discordChs.filter(ch => ch.alertConfig?.isEnabled).length;
      const inactiveCount = discordChs.length - enabledCount;

      $main.innerHTML = `
        <div class="alert-monitor-summary anim">
          <div class="alert-sum-card">
            <div class="alert-sum-icon total">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <div>
              <div class="alert-sum-val">${discordChs.length}</div>
              <div class="alert-sum-lbl">전체 Discord 채널</div>
            </div>
          </div>
          <div class="alert-sum-card">
            <div class="alert-sum-icon enabled">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
            </div>
            <div>
              <div class="alert-sum-val">${enabledCount}</div>
              <div class="alert-sum-lbl">감지 활성 채널</div>
            </div>
          </div>
          <div class="alert-sum-card">
            <div class="alert-sum-icon inactive">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </div>
            <div>
              <div class="alert-sum-val">${inactiveCount}</div>
              <div class="alert-sum-lbl">감지 미설정</div>
            </div>
          </div>
        </div>
        <div class="alert-ch-cards anim d2">
          ${discordChs.map(ch => alertCardHTML(ch)).join('')}
        </div>`;
    }

    function alertCardHTML(ch) {
      const alert = ch.alertConfig || {};
      const isEnabled = alert.isEnabled === true;
      const safeDocId = ch.docId.replace(/'/g, "\\'");

      return `
      <div class="alert-ch-card" id="alert-card-${ch.docId}">
        <div class="alert-ch-card-header">
          <div class="alert-ch-card-icon">${SVG.discord}</div>
          <div class="alert-ch-card-info">
            <div class="alert-ch-card-name"># ${ch.channelName || ch.discordChannelId}</div>
            <div class="alert-ch-card-guild">${ch.discordGuildId || ch.discordChannelId}</div>
          </div>
          <div class="alert-status-badge ${isEnabled ? 'on' : 'off'}" id="ac-badge-${ch.docId}">
            ${isEnabled
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>감지 활성`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>미설정`}
          </div>
        </div>
        <div class="alert-ch-card-body">
          <div class="alert-ch-toggle-row">
            <label class="toggle-switch">
              <input type="checkbox" id="ac-enabled-${ch.docId}" ${isEnabled ? 'checked' : ''} onchange="updateAlertBadge('${safeDocId}')" />
              <div class="toggle-track"></div>
              <div class="toggle-knob"></div>
            </label>
            <span class="alert-ch-toggle-label">위기 감지 알림 활성화</span>
          </div>
          <div class="alert-ch-grid">
            <div class="alert-ch-field">
              <label>부정 임계치 (%)</label>
              <input type="number" id="ac-threshold-${ch.docId}" min="0" max="100"
                value="${alert.negativeThreshold ?? 60}" placeholder="60" />
            </div>
            <div class="alert-ch-field">
              <label>트리거 키워드</label>
              <input type="text" id="ac-keywords-${ch.docId}"
                value="${(alert.triggerKeywords || []).join(', ')}"
                placeholder="환불, 버그, 서버 다운" />
            </div>
            <div class="alert-ch-field full">
              <label>알림 웹훅 URL</label>
              <input type="url" id="ac-webhook-${ch.docId}"
                value="${alert.notifyWebhookUrl || ''}"
                placeholder="https://discord.com/api/webhooks/..." />
            </div>
          </div>
          <div class="alert-ch-footer">
            <span class="alert-ch-msg" id="ac-msg-${ch.docId}"></span>
            <button class="btn-save-alert" onclick="saveAlertCard('${safeDocId}')">저장</button>
          </div>
        </div>
      </div>`;
    }

    function updateAlertBadge(docId) {
      const isEnabled = document.getElementById(`ac-enabled-${docId}`).checked;
      const badge = document.getElementById(`ac-badge-${docId}`);
      badge.className = `alert-status-badge ${isEnabled ? 'on' : 'off'}`;
      badge.innerHTML = isEnabled
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>감지 활성`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>미설정`;
    }

    async function saveAlertCard(docId) {
      const isEnabled = document.getElementById(`ac-enabled-${docId}`).checked;
      const threshold = parseInt(document.getElementById(`ac-threshold-${docId}`).value, 10) || 60;
      const kwRaw = document.getElementById(`ac-keywords-${docId}`).value;
      const webhookUrl = document.getElementById(`ac-webhook-${docId}`).value.trim();
      const $msg = document.getElementById(`ac-msg-${docId}`);
      const btn = document.querySelector(`#alert-card-${docId} .btn-save-alert`);

      const keywords = kwRaw.split(',').map(k => k.trim()).filter(Boolean);

      btn.disabled = true;
      $msg.className = 'alert-ch-msg';
      $msg.textContent = '';

      try {
        await apiFetch(`/channels/settings?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            alertConfig: { isEnabled, negativeThreshold: threshold, triggerKeywords: keywords, notifyWebhookUrl: webhookUrl },
          }),
        });
        $msg.className = 'alert-ch-msg ok';
        $msg.textContent = '저장됨';
        setTimeout(() => { $msg.textContent = ''; }, 2500);
      } catch (err) {
        $msg.className = 'alert-ch-msg err';
        $msg.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    }

    /* ══════════════════════════════════════
       MANUAL TRIGGER
    ══════════════════════════════════════ */
    async function triggerReport() {
      const date = document.getElementById('datePicker').value;
      const today = new Date(Date.now() + 9 * 3_600_000).toISOString().split('T')[0];
      const isToday = date === today;

      const ok = await showConfirm({
        platform: 'discord',
        icon: '🎮',
        title: 'Discord 리포트',
        color: '#5865F2',
        sub: isToday ? '오늘 날짜 — 전체 재생성' : '과거 날짜 — 재발송',
        badge: date,
        desc: isToday
          ? '리포트를 재생성하고 이메일/시트 발송까지 실행합니다. 기존 리포트가 덮어씌워집니다.'
          : '기존 리포트 데이터로 이메일/시트 발송을 재실행합니다.',
        confirmLabel: '실행',
      });
      if (!ok) return;

      const $btn = document.getElementById('triggerBtn');
      const $msg = document.getElementById('triggerMsg');

      $btn.classList.add('spinning');
      $btn.style.pointerEvents = 'none';
      $msg.className = 'trigger-msg run show';
      $msg.textContent = '실행 중…';

      try {
        const r = await apiFetch('/report/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, date }),
        });

        const detail = r.mode === 'full'
          ? `재생성 완료 (처리: ${r.results?.processed ?? 0}, 오류: ${r.results?.errors ?? 0})`
          : `발송 완료 (${r.results?.redelivered ?? 0}개 서버)`;
        $msg.className = 'trigger-msg ok show';
        $msg.textContent = '✓ ' + detail;
        if (isToday) setTimeout(() => loadReport(), 1000);
      } catch (e) {
        $msg.className = 'trigger-msg err show';
        $msg.textContent = '✗ ' + (e.message || '실패');
      } finally {
        $btn.classList.remove('spinning');
        $btn.style.pointerEvents = '';
        setTimeout(() => { $msg.classList.remove('show'); }, 6000);
      }
    }

    /* ══════════════════════════════════════
       DATA MANAGEMENT VIEW
    ══════════════════════════════════════ */
    let _dataAllChannels = [];

    async function loadDataLogs() {
      const $main = document.getElementById('data-log-main');
      $main.innerHTML =
        `<div class="sk" style="height:56px;border-radius:12px;margin-bottom:.75rem"></div>`.repeat(4);

      try {
        // 채널 목록 로드 (길드 필터 드롭다운용)
        const { channels } = await apiFetch(`/channels?workspaceId=${WS}`);
        _dataAllChannels = channels.filter(ch => ch.platform === 'discord');
        populateDataGuildDropdown(_dataAllChannels);

        // 오늘치 수집 로그 조회
        const today = getKSTDateStr();
        const { logs } = await apiFetch(`/data/logs?workspaceId=${WS}&date=${today}`);
        renderDataLogs(logs);
      } catch (err) {
        handleApiError(err, $main);
      }
    }

    // KST 오늘 날짜 (YYYY-MM-DD) — 클라이언트 측 계산 (UTC+9)
    function getKSTDateStr() {
      return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
    }

    function populateDataGuildDropdown(channels) {
      const $sel = document.getElementById('dataGuildFilter');
      const prev = $sel.value;
      const guilds = [...new Map(channels.map(ch => [ch.discordGuildId, ch.guildName || ch.discordGuildId])).entries()];
      $sel.innerHTML = '<option value="all">전체</option>' +
        guilds.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
      if ([...$sel.options].some(o => o.value === prev)) $sel.value = prev;
      updateDataFilterHint();
    }

    function filterDataGuild() {
      updateDataFilterHint();
    }

    function updateDataFilterHint() {
      const val = document.getElementById('dataGuildFilter').value;
      const $hint = document.getElementById('dataFilterHint');
      if ($hint) $hint.style.display = val === 'all' ? '' : 'none';
    }

    function renderDataLogs(logs) {
      const $main = document.getElementById('data-log-main');

      // 안내 힌트 HTML
      const hintHTML = `<div id="dataFilterHint" style="margin-bottom:1.25rem;padding:.625rem .875rem;background:var(--accent-dim);border:1px solid var(--border-accent);border-radius:var(--r-sm);font-size:.8125rem;color:var(--text-2);display:flex;gap:.5rem;align-items:center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;flex-shrink:0;color:var(--accent)"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        특정 서버만 수집하려면 상단 서버 필터를 먼저 선택하세요
      </div>`;

      if (!logs || !logs.length) {
        $main.innerHTML = hintHTML + `<div class="state-wrap">
          <div class="state-icon empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
          </div>
          <div class="state-title">오늘 수집 이력 없음</div>
          <div class="state-desc">상단의 데이터 수집 시작 버튼을 눌러 수집을 시작하세요.</div>
        </div>`;
        updateDataFilterHint();
        return;
      }

      // runId 기준으로 그룹핑 (같은 실행 = 같은 runId)
      const groups = {};
      logs.forEach(log => {
        if (!groups[log.runId]) {
          groups[log.runId] = { runId: log.runId, collectedAt: log.collectedAt, channels: [] };
        }
        groups[log.runId].channels.push(log);
      });

      // 최신 실행이 위로 (내림차순)
      const sorted = Object.values(groups).sort((a, b) =>
        (b.collectedAt || '').localeCompare(a.collectedAt || '')
      );

      const timelineHTML = sorted.map(g => {
        const dt = g.collectedAt ? new Date(g.collectedAt) : null;
        // KST 시각 포맷
        const timeLabel = dt
          ? new Date(dt.getTime() + 9 * 60 * 60 * 1000)
              .toISOString().split('T')[1].substring(0, 5)
          : '--:--';

        const hasInitial = g.channels.some(c => c.type === 'initial');
        const typeLabel  = hasInitial ? '최초 수집' : '증분 수집';
        const typeCls    = hasInitial ? 'data-log-type initial' : 'data-log-type incremental';
        const totalMsgs  = g.channels.reduce((s, c) => s + (c.messageCount || 0), 0);

        const chRows = g.channels.map(c => `
          <div class="data-log-ch-row">
            <span class="data-log-ch-name"># ${c.channelName || c.channelDocId}</span>
            <span class="data-log-ch-guild">${c.guildName || ''}</span>
            <span class="data-log-ch-count">${(c.messageCount || 0).toLocaleString()}개</span>
          </div>`).join('');

        return `
        <div class="data-log-group anim">
          <div class="data-log-header">
            <span class="data-log-time">${timeLabel}</span>
            <span class="${typeCls}">${typeLabel}</span>
            <span class="data-log-total">${totalMsgs.toLocaleString()}개 수집</span>
          </div>
          <div class="data-log-ch-list">${chRows}</div>
        </div>`;
      }).join('');

      $main.innerHTML = hintHTML + `<div class="data-log-timeline">${timelineHTML}</div>`;
      updateDataFilterHint();
    }

    /* ══════════════════════════════════════
       MANUAL COLLECT (Alert Pipeline)
    ══════════════════════════════════════ */
    async function collectNow(context = 'alert') {
      const btnId    = context === 'data' ? 'collectBtnData'  : 'collectBtn';
      const msgId    = context === 'data' ? 'collectMsgData'  : 'collectMsg';
      const filterId = context === 'data' ? 'dataGuildFilter' : 'alertGuildFilter';

      const $btn = document.getElementById(btnId);
      const $msg = document.getElementById(msgId);

      $btn.classList.add('spinning');
      $btn.style.pointerEvents = 'none';
      $msg.className = 'trigger-msg run show';
      $msg.textContent = '수집 중…';

      try {
        const filterGuildId = document.getElementById(filterId).value;
        const body = { workspaceId: WS };
        if (filterGuildId && filterGuildId !== 'all') body.guildId = filterGuildId;

        const r = await apiFetch('/alert/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const guildLabel = (filterGuildId && filterGuildId !== 'all')
          ? document.getElementById(filterId).selectedOptions[0].text
          : '전체';
        const detail = `[${guildLabel}] 수집 ${r.results?.collected ?? 0}채널, 알림 ${r.results?.alerted ?? 0}건`;
        $msg.className = 'trigger-msg ok show';
        $msg.textContent = '✓ ' + detail;
        if (context === 'data') {
          setTimeout(() => loadDataLogs(), 800);
        } else {
          setTimeout(() => loadAlertMonitor(), 800);
        }
      } catch (e) {
        $msg.className = 'trigger-msg err show';
        $msg.textContent = '✗ ' + (e.message || '실패');
      } finally {
        $btn.classList.remove('spinning');
        $btn.style.pointerEvents = '';
        setTimeout(() => { $msg.classList.remove('show'); }, 6000);
      }
    }

    /* ══════════════════════════════════════
       API HELPER
    ══════════════════════════════════════ */
    async function apiFetch(endpoint, opts = {}) {
      const res = await fetch(API + endpoint, {
        ...opts,
        headers: { 'x-admin-secret': secret, ...(opts.headers || {}) },
      });
      if (res.status === 403) {
        const err = Object.assign(new Error('인증 실패'), { code: 403 });
        throw err;
      }
      const json = await res.json();
      if (!res.ok) {
        const err = new Error(json.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.details = json;
        throw err;
      }
      return json;
    }

    function handleApiError(err, $el) {
      if (err.code === 403) {
        sessionStorage.removeItem('sl_secret');
        document.getElementById('overlay').classList.remove('hidden');
        document.getElementById('authErr').textContent = '잘못된 시크릿 키입니다.';
        if ($el) $el.innerHTML = '';
      } else {
        if ($el) $el.innerHTML = errorHTML(err.message);
      }
    }

    /* ══════════════════════════════════════
       REPORT RENDER HELPERS
    ══════════════════════════════════════ */
    function countUp(el, target, suffix) {
      const dur = 650;
      const t0 = performance.now();
      (function tick(now) {
        const t = Math.min((now - t0) / dur, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        el.textContent = Math.round(ease * target) + suffix;
        if (t < 1) requestAnimationFrame(tick);
      })(performance.now());
    }

    function severity(count) {
      if (count >= 10) return { cls: 'sev-high', label: 'HIGH' };
      if (count >= 5) return { cls: 'sev-med', label: 'MED' };
      return { cls: 'sev-low', label: 'LOW' };
    }

    /* ── SVG library ── */
    const SVG = {
      msg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
      smile: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 13s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`,
      frown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M16 15s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`,
      warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
      doc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
      tag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
      bar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
      info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
      check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
      plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
      discord: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`,
    };

    /* ── Skeleton ── */
    function skeletonHTML() {
      return `
      <div style="margin-bottom:2.25rem">
        <div class="sk" style="width:300px;height:38px;border-radius:8px;margin-bottom:.625rem"></div>
        <div class="sk" style="width:200px;height:13px;border-radius:5px"></div>
      </div>
      <div class="stat-grid" style="margin-bottom:1.125rem">
        ${[0, 1, 2].map(() => `<div class="sk" style="height:106px;border-radius:12px"></div>`).join('')}
      </div>
      <div class="sk" style="height:130px;border-radius:12px;margin-bottom:1rem"></div>
      <div class="two-col">
        <div class="sk sk--chart"></div>
        <div class="sk sk--chart"></div>
      </div>`;
    }

    function emptyHTML(date) {
      return `<div class="state-wrap">
      <div class="state-icon empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          <path d="M8 10h8M8 14h5" opacity=".4"/>
        </svg>
      </div>
      <div class="state-title">${date} 리포트 없음</div>
      <div class="state-desc">해당 날짜에 수집된 데이터가 없습니다.<br>파이프라인이 실행된 날짜를 선택해 주세요.</div>
    </div>`;
    }

    function errorHTML(msg) {
      return `<div class="state-wrap">
      <div class="state-icon error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </div>
      <div class="state-title">데이터를 불러올 수 없습니다</div>
      <div class="state-desc">${escapeHtml(msg)}</div>
    </div>`;
    }

    /* ── Dashboard render ── */
    function dashHTML({ date, guilds }) {
      const isEN = _reportLang === 'en';
      const d = new Date(date + 'T00:00:00+09:00');
      const dateLabel = d.toLocaleDateString(isEN ? 'en-US' : 'ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
      const totalChannels = guilds.reduce((s, g) => s + (g.channels || []).length, 0);
      const subtitle = isEN
        ? `Community Intelligence Report &middot; ${guilds.length} servers &middot; ${totalChannels} channels`
        : `커뮤니티 인텔리전스 리포트 &middot; ${guilds.length}개 서버 &middot; ${totalChannels}개 채널 분석`;
      return `
      <div class="page-bar anim">
        <div class="page-date-h">${dateLabel}</div>
        <div class="page-sub">${subtitle}</div>
      </div>
      ${guilds.map((g, i) => (i > 0 ? '<div class="ch-divider"></div>' : '') + guildHTML(g)).join('')}`;
    }

    function guildHTML(g) {
      const isEN = _reportLang === 'en';
      const L = isEN ? {
        alertBadge: 'Crisis Alert', badgePos: 'Positive', badgeNeg: 'Negative',
        impHigh: 'High', impNormal: 'Normal', impLow: 'Low',
        msgCountLabel: 'Messages', domPos: 'Positive', domNeg: 'Negative', issuesLabel: 'Issues',
        summaryLabel: 'Server Trend Summary', sentimentLabel: 'Sentiment Analysis',
        posLabel: 'Positive', neuLabel: 'Neutral', negLabel: 'Negative',
        keywordsLabel: 'Key Keywords', noKeywords: 'No keywords',
        issuesSectionLabel: 'Key Issues', channelsSectionLabel: 'Channel Summaries',
        msgUnit: 'msgs', server: 'Discord server', channels: 'channels',
        promptLabel: 'Prompt', responseLabel: 'Response', totalLabel: 'Total', tokensLabel: 'tokens', costLabel: 'Cost',
        viewMsg: 'View in Discord',
      } : {
        alertBadge: '위기 알림', badgePos: '긍정 우세', badgeNeg: '부정 우세',
        impHigh: '높음', impNormal: '보통', impLow: '낮음',
        msgCountLabel: '수집된 메시지', domPos: '긍정 감정', domNeg: '부정 감정', issuesLabel: '감지된 이슈',
        summaryLabel: '서버 동향 요약', sentimentLabel: '감정 분석',
        posLabel: '긍정', neuLabel: '중립', negLabel: '부정',
        keywordsLabel: '핵심 키워드', noKeywords: '키워드 없음',
        issuesSectionLabel: '주요 이슈', channelsSectionLabel: '채널별 요약',
        msgUnit: '건', server: 'Discord 서버', channels: '개 채널',
        promptLabel: '프롬프트', responseLabel: '응답', totalLabel: '합계', tokensLabel: '토큰', costLabel: '비용',
        viewMsg: 'Discord에서 원문 보기',
      };

      const s = g.sentiment || {};
      const pos = s.positive ?? 0, neu = s.neutral ?? 0, neg = s.negative ?? 0;
      const domPos = pos >= neg;
      const issues = g.issues || [];
      const channels = g.channels || [];

      let badge = '';
      if (g.isAlertTriggered) badge = `<div class="badge alert">${SVG.warn} ${L.alertBadge}</div>`;
      else if (domPos && pos > 0) badge = `<div class="badge pos">${SVG.check} ${L.badgePos}</div>`;
      else if (!domPos && neg > 0) badge = `<div class="badge neg">${SVG.warn} ${L.badgeNeg}</div>`;

      const impLabelMap = { high: L.impHigh, normal: L.impNormal, low: L.impLow };

      const channelSummaries = channels.map(ch => {
        const imp = ch.importance || 'normal';
        const cs = ch.sentiment || {};
        const cp = cs.positive ?? 0, cn = cs.neutral ?? 0, ce = cs.negative ?? 0;
        const chSummary = isEN ? (ch.summary_en || ch.summary) : ch.summary;
        return `
        <div class="guild-report-ch">
          <div class="guild-report-ch-top">
            <span class="imp-badge imp-${imp}">${impLabelMap[imp]}</span>
            <span class="guild-report-ch-name">#${ch.channelName || ch.channelDocId}</span>
            <span class="guild-report-ch-count">${ch.messageCount ?? 0}${L.msgUnit}</span>
          </div>
          ${chSummary ? `<div class="guild-report-ch-summary">${DOMPurify.sanitize(chSummary)}</div>` : ''}
          <div class="guild-report-ch-sent">
            <div class="s-pos" style="width:${cp}%"></div>
            <div class="s-neu" style="width:${cn}%"></div>
            <div class="s-neg" style="width:${ce}%"></div>
          </div>
        </div>`;
      }).join('');

      const noData = g.noData === true || (g.messageCount ?? 0) === 0;
      const summaryText = isEN ? (g.summary_en || g.summary) : g.summary;
      const keywords = isEN ? (g.keywords_en || g.keywords || []) : (g.keywords || []);

      return `
      <div class="ch-header anim d1">
        <div class="ch-platform-icon">${SVG.discord}</div>
        <div>
          <div class="ch-name">${g.guildName || '서버'}</div>
          <div class="ch-id">${L.server} &middot; ${channels.length}${L.channels}</div>
        </div>
        <div class="ch-badges">${badge}</div>
      </div>

      <div class="stat-grid anim d2">
        <div class="stat-card">
          <div class="stat-icon-wrap si-msg">${SVG.msg}</div>
          <div class="stat-val" data-target="${g.messageCount ?? 0}">0</div>
          <div class="stat-lbl">${L.msgCountLabel}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon-wrap ${domPos ? 'si-sent' : 'si-neg'}">${domPos ? SVG.smile : SVG.frown}</div>
          <div class="stat-val" data-target="${domPos ? pos : neg}" data-suffix="%">0%</div>
          <div class="stat-lbl">${domPos ? L.domPos : L.domNeg}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon-wrap si-warn">${SVG.warn}</div>
          <div class="stat-val" data-target="${issues.length}">0</div>
          <div class="stat-lbl">${L.issuesLabel}</div>
        </div>
      </div>

      <div class="scard anim d3">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.doc}${L.summaryLabel}</div>
        <p class="summary-body">${noData ? '<span class="text-sm-muted">분석 메시지가 없습니다.</span>' : formatSummary(summaryText)}</p>
      </div>

      ${noData ? '' : `
      <div class="two-col anim d4">
        <div class="scard">
          <div class="slabel"><div class="slabel-dot"></div>${SVG.bar}${L.sentimentLabel}</div>
          <div class="sent-wrap">
            <div class="sent-spectrum">
              <div class="sent-seg pos" data-v="${pos}" style="width:0%"></div>
              <div class="sent-seg neu" data-v="${neu}" style="width:0%"></div>
              <div class="sent-seg neg" data-v="${neg}" style="width:0%"></div>
            </div>
            <div class="sent-tiles">
              <div class="sent-tile"><div class="sent-tile-val pos">${pos}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">${L.posLabel}</div></div>
              <div class="sent-tile"><div class="sent-tile-val neu">${neu}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">${L.neuLabel}</div></div>
              <div class="sent-tile"><div class="sent-tile-val neg">${neg}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">${L.negLabel}</div></div>
            </div>
          </div>
        </div>
        <div class="scard">
          <div class="slabel"><div class="slabel-dot"></div>${SVG.tag}${L.keywordsLabel}</div>
          <div class="kw-wrap">
            ${keywords.length
          ? keywords.map(k => `<span class="kw"><span class="kw-hash">#</span>${escapeHtml(k)}</span>`).join('')
          : `<span class="text-sm-muted">${L.noKeywords}</span>`}
          </div>
        </div>
      </div>`}

      ${issues.length ? `
      <div class="scard scard--mt anim d5">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.warn}${L.issuesSectionLabel} <span class="slabel-count">${issues.length}${isEN ? '' : '건'}</span></div>
        <div class="issues-list">
          ${issues.map(iss => {
            const sev = severity(iss.count);
            const chLabel = iss.channel ? `<span class="issue-ch-label">#${iss.channel}</span>` : '';
            const msgLink = (iss.channelId && iss.messageId && g.discordGuildId)
              ? `<a href="https://discord.com/channels/${g.discordGuildId}/${iss.channelId}/${iss.messageId}" target="_blank" class="issue-msg-link" title="${L.viewMsg}">↗</a>`
              : '';
            const issTitle = isEN ? (iss.title_en || iss.title) : iss.title;
            const issDesc  = isEN ? (iss.description_en || iss.description) : iss.description;
            return `
            <div class="issue-card ${sev.cls}">
              <div class="issue-sev-bar"></div>
              <div class="issue-count-badge">${iss.count}</div>
              <div class="issue-body">
                <div class="issue-title">${issTitle}${chLabel}${msgLink}</div>
                <div class="issue-desc">${issDesc}</div>
              </div>
              <div class="issue-sev-label">${sev.label}</div>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

      ${channels.length ? `
      <div class="scard scard--mt anim d5 guild-report-channels">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.msg}${L.channelsSectionLabel} <span class="slabel-count">${channels.length}${isEN ? '' : '개'}</span></div>
        ${channelSummaries}
      </div>` : ''}

      ${(g.model || g.totalTokens) ? `
      <div class="token-info-strip anim d5">
        ${g.model ? `<span class="token-model">${g.model}</span>` : ''}
        ${g.totalTokens ? `<span>${L.promptLabel} ${(g.promptTokens || 0).toLocaleString()} / ${L.responseLabel} ${(g.completionTokens || 0).toLocaleString()} / ${L.totalLabel} ${(g.totalTokens || 0).toLocaleString()} ${L.tokensLabel}</span>` : ''}
        ${g.cost != null ? `<span>${L.costLabel} $${Number(g.cost).toFixed(4)}</span>` : ''}
      </div>` : ''}`;
    }

    function channelHTML(ch) {
      const s = ch.sentiment || {};
      const pos = s.positive ?? 0, neu = s.neutral ?? 0, neg = s.negative ?? 0;
      const domPos = pos >= neg;
      const issues = ch.issues || [];

      let badge = '';
      if (ch.isAlertTriggered) badge = `<div class="badge alert">${SVG.warn} 위기 알림</div>`;
      else if (domPos && pos > 0) badge = `<div class="badge pos">${SVG.check} 긍정 우세</div>`;
      else if (!domPos && neg > 0) badge = `<div class="badge neg">${SVG.warn} 부정 우세</div>`;

      return `
      <div class="ch-header anim d1">
        <div class="ch-platform-icon">${SVG.discord}</div>
        <div>
          <div class="ch-name"># ${ch.channelName || 'general'}</div>
          <div class="ch-id">Discord &middot; ${ch.discordChannelId}</div>
        </div>
        <div class="ch-badges">${badge}</div>
      </div>

      <div class="stat-grid anim d2">
        <div class="stat-card">
          <div class="stat-icon-wrap si-msg">${SVG.msg}</div>
          <div class="stat-val" data-target="${ch.messageCount ?? 0}">0</div>
          <div class="stat-lbl">수집된 메시지</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon-wrap ${domPos ? 'si-sent' : 'si-neg'}">${domPos ? SVG.smile : SVG.frown}</div>
          <div class="stat-val" data-target="${domPos ? pos : neg}" data-suffix="%">0%</div>
          <div class="stat-lbl">${domPos ? '긍정 감정' : '부정 감정'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon-wrap si-warn">${SVG.warn}</div>
          <div class="stat-val" data-target="${issues.length}">0</div>
          <div class="stat-lbl">감지된 이슈</div>
        </div>
      </div>

      <div class="scard anim d3">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.doc}동향 요약</div>
        <p class="summary-body">${ch.summary || '—'}</p>
      </div>

      ${ch.custom_answer ? `
      <div class="scard anim d4">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.info}맞춤 분석</div>
        <p class="custom-body">${ch.custom_answer}</p>
      </div>` : ''}

      <div class="two-col anim d4">
        <div class="scard">
          <div class="slabel"><div class="slabel-dot"></div>${SVG.bar}감정 분석</div>
          <div class="sent-wrap">
            <div class="sent-spectrum">
              <div class="sent-seg pos" data-v="${pos}" style="width:0%"></div>
              <div class="sent-seg neu" data-v="${neu}" style="width:0%"></div>
              <div class="sent-seg neg" data-v="${neg}" style="width:0%"></div>
            </div>
            <div class="sent-tiles">
              <div class="sent-tile"><div class="sent-tile-val pos">${pos}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">긍정</div></div>
              <div class="sent-tile"><div class="sent-tile-val neu">${neu}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">중립</div></div>
              <div class="sent-tile"><div class="sent-tile-val neg">${neg}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">부정</div></div>
            </div>
          </div>
        </div>
        <div class="scard">
          <div class="slabel"><div class="slabel-dot"></div>${SVG.tag}핵심 키워드</div>
          <div class="kw-wrap">
            ${(ch.keywords || []).length
          ? ch.keywords.map(k => `<span class="kw"><span class="kw-hash">#</span>${escapeHtml(k)}</span>`).join('')
          : `<span class="text-sm-muted">키워드 없음</span>`}
          </div>
        </div>
      </div>

      ${issues.length ? `
      <div class="scard scard--mt anim d5">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.warn}주요 이슈 <span class="slabel-count">${issues.length}건</span></div>
        <div class="issues-list">
          ${issues.map(iss => {
            const sev = severity(iss.count);
            return `
            <div class="issue-card ${sev.cls}">
              <div class="issue-sev-bar"></div>
              <div class="issue-count-badge">${iss.count}</div>
              <div class="issue-body">
                <div class="issue-title">${iss.title}</div>
                <div class="issue-desc">${iss.description}</div>
              </div>
              <div class="issue-sev-label">${sev.label}</div>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}`;
    }

    /* ══════════════════════════════════════
       WEEKLY REPORT VIEW
    ══════════════════════════════════════ */
    async function loadWeeklyReport() {
      const weekStart = document.getElementById('weekStartInput').value;
      if (!weekStart) return;
      const $main = document.getElementById('weekly-main');
      const $btn  = document.getElementById('weeklyRefreshBtn');

      $btn.classList.add('spinning');
      $main.innerHTML = skeletonHTML();
      try {
        const { guilds } = await apiFetch(`/weekly-report?workspaceId=${WS}&weekStart=${weekStart}`);
        _weeklyAllGuilds = guilds || [];
        populateWeeklyGuildDropdown(_weeklyAllGuilds);
        renderWeeklyView(weekStart);
      } catch (err) {
        handleApiError(err, $main);
      } finally {
        $btn.classList.remove('spinning');
      }
    }

    function populateWeeklyGuildDropdown(guilds) {
      const $sel = document.getElementById('weeklyGuildFilter');
      const prev = $sel.value;
      $sel.innerHTML = '<option value="all">전체</option>' +
        guilds.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.guildName || g.id)}</option>`).join('');
      if ([...$sel.options].some(o => o.value === prev)) $sel.value = prev;
    }

    function filterWeeklyGuild() {
      renderWeeklyView(document.getElementById('weekStartInput').value);
    }

    function renderWeeklyView(weekStart) {
      const $main = document.getElementById('weekly-main');
      const filterVal = document.getElementById('weeklyGuildFilter').value;
      const guilds = filterVal === 'all'
        ? _weeklyAllGuilds
        : _weeklyAllGuilds.filter(g => g.id === filterVal);

      if (!guilds.length) {
        $main.innerHTML = emptyHTML(weekStart);
        return;
      }

      const weekEnd = guilds[0]?.weekEnd || '';
      const d1 = new Date(weekStart + 'T00:00:00+09:00');
      const d2 = weekEnd ? new Date(weekEnd + 'T00:00:00+09:00') : null;
      const d1Label = d1.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
      const d2Label = d2 ? d2.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }) : '';
      const dateRange = d2Label ? `${d1Label} ~ ${d2Label}` : d1Label;

      $main.innerHTML = `
        <div class="page-bar anim">
          <div class="page-date-h">${dateRange}</div>
          <div class="page-sub">주간 커뮤니티 리포트 &middot; ${guilds.length}개 서버 분석</div>
        </div>
        ${guilds.map((g, i) => (i > 0 ? '<div class="ch-divider"></div>' : '') + weeklyGuildHTML(g)).join('')}`;
      guilds.forEach(g => renderWeeklyCharts(g));
    }

    async function triggerWeeklyReport() {
      const weekStart = document.getElementById('weekStartInput').value;
      if (!confirm(`${weekStart || '이번 주'} 주간 리포트를 생성하시겠습니까?\nAI 분석 비용이 발생합니다.`)) return;
      try {
        await apiFetch('/weekly-report/trigger', { method: 'POST', body: { workspaceId: WS, weekStart: weekStart || undefined } });
        alert('생성 요청 완료. 잠시 후 조회하세요.');
      } catch (err) {
        alert('오류: ' + err.message);
      }
    }

    function weeklyGuildHTML(g) {
      const isEN = _reportLang === 'en';
      const L = isEN ? {
        server: 'Discord server', insights: 'Server Insights', sentimentTrend: 'Sentiment Trend',
        weeklySummary: 'Weekly Trend Summary', weeklyIssues: 'Key Issues', countUnit: 'occurrences',
      } : {
        server: 'Discord 서버', insights: '서버 인사이트', sentimentTrend: '감정 분석 추이',
        weeklySummary: '주간 동향 요약', weeklyIssues: '주요 이슈', countUnit: '회',
      };

      const safeId = g.id.replace(/[^a-zA-Z0-9_]/g, '_');
      const aiSummaryText = isEN ? (g.aiSummary_en || g.aiSummary) : g.aiSummary;

      const issuesHtml = (g.weeklyIssues || []).length === 0 ? '' : `
        <div class="scard" style="margin-top:16px">
          <div class="slabel"><div class="slabel-dot"></div>🚨 ${L.weeklyIssues} <span class="slabel-count">${(g.weeklyIssues || []).length}${isEN ? '' : '건'}</span></div>
          ${(g.weeklyIssues || []).map(i => {
            const datePart = Array.isArray(i.dates) && i.dates.length
              ? i.dates.map(d => d.slice(5)).join(' · ')
              : (i.date ? i.date.slice(5) : '');
            const countPart = i.count ? `${i.count}${L.countUnit}` : '';
            const metaParts = [datePart, countPart].filter(Boolean).join(' / ');
            const issTitle = isEN ? (i.title_en || i.title) : i.title;
            const issDesc  = isEN ? (i.description_en || i.description) : i.description;
            return `
            <div style="padding:10px 14px;background:#fef2f2;border-left:3px solid #ef4444;border-radius:0 8px 8px 0;margin-bottom:8px">
              <div style="font-weight:600;font-size:13px;color:#991b1b">${issTitle}${metaParts ? ` <span style="font-weight:400;font-size:11px;color:#b91c1c">(${metaParts})</span>` : ''}</div>
              <div style="font-size:12px;color:#7f1d1d;margin-top:4px">${issDesc}</div>
            </div>`;
          }).join('')}
        </div>`;

      return `
        <div class="ch-header anim d1">
          <div class="ch-platform-icon">${SVG.discord}</div>
          <div>
            <div class="ch-name">${g.guildName || '서버'}</div>
            <div class="ch-id">${L.server}</div>
          </div>
        </div>
        <div style="margin-bottom:32px">
          <div class="scard scard--mb">
            <div class="slabel"><div class="slabel-dot"></div>📡 ${L.insights} (${g.weekStart} ~ ${g.weekEnd})</div>
            <canvas id="insightChart_${safeId}" height="80"></canvas>
          </div>
          <div class="scard scard--mb">
            <div class="slabel"><div class="slabel-dot"></div>💬 ${L.sentimentTrend}</div>
            <canvas id="sentimentChart_${safeId}" height="80"></canvas>
          </div>
          <div class="scard scard--mb">
            <div class="slabel"><div class="slabel-dot"></div>🗓️ ${L.weeklySummary}</div>
            <p class="summary-body">${formatSummary(aiSummaryText)}</p>
          </div>
          ${issuesHtml}
        </div>`;
    }

    function renderWeeklyCharts(g) {
      const safeId = g.id.replace(/[^a-zA-Z0-9_]/g, '_');
      const labels = (g.insightsChart || []).map(d => d.date.slice(5)); // MM-DD

      // 인사이트 라인 차트
      const insightCtx = document.getElementById(`insightChart_${safeId}`)?.getContext('2d');
      if (insightCtx) {
        new Chart(insightCtx, {
          type: 'line',
          data: {
            labels,
            datasets: [
              { label: '총 멤버',   data: (g.insightsChart || []).map(d => d.totalMembers),         borderColor: '#6366f1', tension: 0.3, fill: false },
              { label: '소통 멤버', data: (g.insightsChart || []).map(d => d.communicatingMembers), borderColor: '#22c55e', tension: 0.3, fill: false },
              { label: '활성 멤버', data: (g.insightsChart || []).map(d => d.activeMembers),        borderColor: '#f59e0b', tension: 0.3, fill: false },
              { label: '메시지 수', data: (g.insightsChart || []).map(d => d.messageCount),         borderColor: '#3b82f6', tension: 0.3, fill: false, yAxisID: 'y2' },
            ]
          },
          options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
              y:  { position: 'left',  title: { display: true, text: '멤버 수' } },
              y2: { position: 'right', title: { display: true, text: '메시지' }, grid: { drawOnChartArea: false } },
            }
          }
        });
      }

      // 감정 누적 막대 차트
      const sentCtx = document.getElementById(`sentimentChart_${safeId}`)?.getContext('2d');
      if (sentCtx) {
        new Chart(sentCtx, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              { label: '긍정', data: (g.sentimentChart || []).map(d => d.positive), backgroundColor: '#22c55e' },
              { label: '중립', data: (g.sentimentChart || []).map(d => d.neutral),  backgroundColor: '#94a3b8' },
              { label: '부정', data: (g.sentimentChart || []).map(d => d.negative), backgroundColor: '#ef4444' },
            ]
          },
          options: {
            responsive: true,
            scales: { x: { stacked: true }, y: { stacked: true, max: 100 } }
          }
        });
      }
    }

    // ── 커스텀 분석 ─────────────────────────────────────────────────────────
    let _analyticsAllGuilds = [];

    async function loadAnalytics() {
      const startDate = document.getElementById('analyticsStartDate').value;
      const endDate   = document.getElementById('analyticsEndDate').value;
      if (!startDate || !endDate) return;

      const $main = document.getElementById('analytics-main');
      $main.innerHTML = '<div class="loading">로딩 중…</div>';

      try {
        const data = await apiFetch(`/analytics?workspaceId=${WS}&startDate=${startDate}&endDate=${endDate}`);
        _analyticsAllGuilds = data.guilds || [];

        // 길드 필터 드롭다운 populate
        const $sel = document.getElementById('analyticsGuildFilter');
        const prev = $sel.value;
        $sel.innerHTML = '<option value="all">전체</option>' +
          _analyticsAllGuilds.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.guildName || g.id)}</option>`).join('');
        if ([...$sel.options].some(o => o.value === prev)) $sel.value = prev;

        renderAnalyticsView(startDate, endDate);
      } catch (err) {
        $main.innerHTML = `<div class="empty-state">오류: ${escapeHtml(err.message)}</div>`;
      }
    }

    function filterAnalyticsGuild() {
      const startDate = document.getElementById('analyticsStartDate').value;
      const endDate   = document.getElementById('analyticsEndDate').value;
      renderAnalyticsView(startDate, endDate);
    }

    function renderAnalyticsView(startDate, endDate) {
      const $main    = document.getElementById('analytics-main');
      const filterVal = document.getElementById('analyticsGuildFilter').value;
      const guilds   = filterVal === 'all'
        ? _analyticsAllGuilds
        : _analyticsAllGuilds.filter(g => g.id === filterVal);

      if (!guilds.length) {
        $main.innerHTML = '<div class="empty-state">해당 기간에 데이터가 없습니다.</div>';
        return;
      }

      const d1 = new Date(startDate + 'T00:00:00+09:00');
      const d2 = new Date(endDate   + 'T00:00:00+09:00');
      const fmtKo = d => d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
      const dateRange = `${fmtKo(d1)} ~ ${fmtKo(d2)}`;

      $main.innerHTML = `
        <div class="page-bar anim">
          <div class="page-date-h">${dateRange}</div>
          <div class="page-sub">커스텀 기간 분석 &middot; ${guilds.length}개 서버</div>
        </div>
        ${guilds.map((g, i) => (i > 0 ? '<div class="ch-divider"></div>' : '') + analyticsGuildHTML(g, startDate, endDate)).join('')}`;
      guilds.forEach(g => renderAnalyticsCharts(g));
    }

    function analyticsGuildHTML(g, startDate, endDate) {
      const safeId = g.id.replace(/[^a-zA-Z0-9_]/g, '_');
      return `
        <div class="ch-header anim d1">
          <div class="ch-platform-icon">${SVG.discord}</div>
          <div>
            <div class="ch-name">${g.guildName || '서버'}</div>
            <div class="ch-id">Discord 서버</div>
          </div>
        </div>
        <div style="margin-bottom:32px">
          <div class="scard scard--mb">
            <div class="slabel"><div class="slabel-dot"></div>📡 서버 인사이트 (${startDate} ~ ${endDate})</div>
            <canvas id="aInsightChart_${safeId}" height="80"></canvas>
            ${buildInsightTable(safeId, g.insightsChart || [])}
          </div>
          <div class="scard scard--mb">
            <div class="slabel"><div class="slabel-dot"></div>💬 감정 분포 추이</div>
            <canvas id="aSentimentChart_${safeId}" height="80"></canvas>
            ${buildSentimentTable(safeId, g.sentimentChart || [])}
          </div>
        </div>`;
    }

    function buildInsightTable(safeId, data) {
      if (!data.length) return '';
      const cutoff = Math.max(0, data.length - 7);
      const fmt = v => v != null ? Number(v).toLocaleString() : '—';
      const row = (d, hidden) =>
        `<tr${hidden ? ' class="tbl-hidden"' : ''}>`
        + `<td>${d.date.slice(5)}</td>`
        + `<td>${fmt(d.totalMembers)}</td>`
        + `<td>${fmt(d.communicatingMembers)}</td>`
        + `<td>${fmt(d.activeMembers)}</td>`
        + `<td>${fmt(d.messageCount)}</td>`
        + `</tr>`;
      const hasMore = cutoff > 0;
      return `
        <div class="analytics-tbl-wrap">
          <table class="analytics-tbl" id="itbl_${safeId}">
            <thead><tr><th>날짜</th><th>총 멤버</th><th>소통 멤버</th><th>활성 멤버</th><th>메시지 수</th></tr></thead>
            <tbody>
              ${data.slice(0, cutoff).map(d => row(d, true)).join('')}
              ${data.slice(cutoff).map(d => row(d, false)).join('')}
            </tbody>
          </table>
        </div>
        ${hasMore ? `<div class="analytics-tbl-footer"><button class="tbl-more-btn" onclick="toggleAnalyticsTbl(this,'itbl_${safeId}',${data.length})">전체 보기 (${data.length}일)</button></div>` : ''}`;
    }

    function buildSentimentTable(safeId, data) {
      if (!data.length) return '';
      const cutoff = Math.max(0, data.length - 7);
      const fmtPct = v => v != null ? v + '%' : '—';
      const row = (d, hidden) =>
        `<tr${hidden ? ' class="tbl-hidden"' : ''}>`
        + `<td>${d.date.slice(5)}</td>`
        + `<td class="${d.positive != null ? 'sent-pos' : ''}">${fmtPct(d.positive)}</td>`
        + `<td class="${d.neutral  != null ? 'sent-neu' : ''}">${fmtPct(d.neutral)}</td>`
        + `<td class="${d.negative != null ? 'sent-neg' : ''}">${fmtPct(d.negative)}</td>`
        + `</tr>`;
      const hasMore = cutoff > 0;
      return `
        <div class="analytics-tbl-wrap">
          <table class="analytics-tbl" id="stbl_${safeId}">
            <thead><tr><th>날짜</th><th>긍정</th><th>중립</th><th>부정</th></tr></thead>
            <tbody>
              ${data.slice(0, cutoff).map(d => row(d, true)).join('')}
              ${data.slice(cutoff).map(d => row(d, false)).join('')}
            </tbody>
          </table>
        </div>
        ${hasMore ? `<div class="analytics-tbl-footer"><button class="tbl-more-btn" onclick="toggleAnalyticsTbl(this,'stbl_${safeId}',${data.length})">전체 보기 (${data.length}일)</button></div>` : ''}`;
    }

    function toggleAnalyticsTbl(btn, tblId, totalDays) {
      const tbl = document.getElementById(tblId);
      const expanded = tbl.classList.toggle('tbl-expanded');
      btn.textContent = expanded ? '접기' : `전체 보기 (${totalDays}일)`;
    }

    function renderAnalyticsCharts(g) {
      const safeId = g.id.replace(/[^a-zA-Z0-9_]/g, '_');
      const labels = (g.insightsChart || []).map(d => d.date.slice(5)); // MM-DD

      // 인사이트 라인 차트 (이중 Y축)
      const insightCtx = document.getElementById(`aInsightChart_${safeId}`)?.getContext('2d');
      if (insightCtx) {
        new Chart(insightCtx, {
          type: 'line',
          data: {
            labels,
            datasets: [
              { label: '총 멤버',   data: (g.insightsChart || []).map(d => d.totalMembers),         borderColor: '#6366f1', tension: 0.3, fill: false },
              { label: '소통 멤버', data: (g.insightsChart || []).map(d => d.communicatingMembers), borderColor: '#22c55e', tension: 0.3, fill: false },
              { label: '활성 멤버', data: (g.insightsChart || []).map(d => d.activeMembers),        borderColor: '#f59e0b', tension: 0.3, fill: false },
              { label: '메시지 수', data: (g.insightsChart || []).map(d => d.messageCount),         borderColor: '#3b82f6', tension: 0.3, fill: false, yAxisID: 'y2' },
            ]
          },
          options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            spanGaps: true,
            scales: {
              y:  { position: 'left',  title: { display: true, text: '멤버 수' } },
              y2: { position: 'right', title: { display: true, text: '메시지' }, grid: { drawOnChartArea: false } },
            }
          }
        });
      }

      // 감정 100% 누적 막대 차트
      const sentCtx = document.getElementById(`aSentimentChart_${safeId}`)?.getContext('2d');
      if (sentCtx) {
        new Chart(sentCtx, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              { label: '긍정', data: (g.sentimentChart || []).map(d => d.positive), backgroundColor: '#22c55e' },
              { label: '중립', data: (g.sentimentChart || []).map(d => d.neutral),  backgroundColor: '#94a3b8' },
              { label: '부정', data: (g.sentimentChart || []).map(d => d.negative), backgroundColor: '#ef4444' },
            ]
          },
          options: {
            responsive: true,
            scales: { x: { stacked: true }, y: { stacked: true, max: 100 } }
          }
        });
      }
    }

    /* ══════════════════════════════════════
       INSTAGRAM — 계정 관리
    ══════════════════════════════════════ */

    function escapeHtml(str) {
      if (str == null) return '';
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function sanitizeReportHtml(html) {
      if (!html || typeof html !== 'string') return '';
      return html.replace(/<(?!\/?(?:br|strong)\b)[^>]*>/gi, '');
    }

    /* ─── Confirm Modal ─────────────────────────────── */
    let _confirmResolve = () => {};

    function showConfirm({ platform = 'discord', icon = '', title = '', badge = '', sub = '', desc = '', confirmLabel = '실행', color = '#6366f1', extraHtml = '' }) {
      return new Promise(resolve => {
        _confirmResolve = (val) => {
          document.getElementById('confirmOverlay').classList.add('hidden');
          resolve(val);
        };
        const overlay = document.getElementById('confirmOverlay');
        document.getElementById('confirmHeader').style.borderBottomColor = color + '33';
        document.getElementById('confirmIcon').textContent = icon;
        document.getElementById('confirmTitle').style.color = color;
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmBadge').textContent = badge;
        document.getElementById('confirmBadge').style.color = color;
        document.getElementById('confirmSub').textContent = sub;
        document.getElementById('confirmDesc').textContent = desc;
        const extraEl = document.getElementById('confirmExtra');
        if (extraEl) {
          extraEl.innerHTML = extraHtml || '';
          extraEl.classList.toggle('hidden', !extraHtml);
        }
        const okBtn = document.getElementById('confirmOkBtn');
        okBtn.textContent = confirmLabel;
        okBtn.style.background = color;
        overlay.classList.remove('hidden');
        okBtn.focus();
      });
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const overlay = document.getElementById('confirmOverlay');
        if (!overlay.classList.contains('hidden')) _confirmResolve(false);
      }
    });

    function tokenExpiryLabel(tokenExpiresAt) {
      if (!tokenExpiresAt) return { text: '만료일 없음', color: '#94a3b8' };
      const expiresMs = typeof tokenExpiresAt === 'object' && tokenExpiresAt._seconds
        ? tokenExpiresAt._seconds * 1000
        : new Date(tokenExpiresAt).getTime();
      const daysLeft = Math.floor((expiresMs - Date.now()) / (24 * 60 * 60 * 1000));
      if (daysLeft < 0)  return { text: '만료됨', color: '#ef4444' };
      if (daysLeft < 14) return { text: `만료 임박! (${daysLeft}일)`, color: '#ef4444' };
      return { text: `만료까지 ${daysLeft}일`, color: '#64748b' };
    }

    async function loadIgAccounts() {
      const $main = document.getElementById('ig-accounts-main');
      $main.innerHTML = `<div class="ch-mgmt-grid">
        <div class="add-panel">
          <div class="panel-title">계정 추가</div>
          <div class="panel-desc">API 타입을 선택한 후 액세스 토큰을 입력합니다.</div>
          <div class="ig-api-type-toggle" style="display:flex;gap:.5rem;margin-bottom:1rem">
            <button type="button" id="igApiTypeFacebook" class="ig-api-type-btn active" onclick="setIgApiType('facebook')" style="flex:1;padding:.5rem .75rem;border-radius:8px;font-size:.8125rem;font-weight:600;border:2px solid var(--border);background:var(--bg-card);cursor:pointer;transition:all .15s">Facebook API</button>
            <button type="button" id="igApiTypeInstagram" class="ig-api-type-btn" onclick="setIgApiType('instagram')" style="flex:1;padding:.5rem .75rem;border-radius:8px;font-size:.8125rem;font-weight:600;border:2px solid var(--border);background:var(--bg-card);cursor:pointer;transition:all .15s">Instagram API</button>
          </div>
          <div class="info-banner" id="igApiTypeInfo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span id="igApiTypeInfoText">토큰 발급: Meta 개발자 콘솔 → 그래프 API 탐색기 → User Token 생성 (instagram_basic, instagram_manage_insights, pages_show_list 권한 포함) → 장기 토큰(EAAxxxx)으로 교환</span>
          </div>
          <div id="igFacebookFields">
            <div class="field-group">
              <label class="field-label">Meta 앱 ID <span class="text-neg">*</span></label>
              <input class="field-input" id="igAppIdInput" type="text" placeholder="1234567890" autocomplete="off">
            </div>
            <div class="field-group">
              <label class="field-label">Meta 앱 시크릿 <span class="text-neg">*</span></label>
              <input class="field-input" id="igAppSecretInput" type="password" placeholder="앱 시크릿 코드" autocomplete="off">
            </div>
          </div>
          <div class="field-group">
            <label class="field-label" id="igTokenLabel">Long-lived Access Token <span class="text-neg">*</span></label>
            <textarea class="field-input settings-textarea" id="igTokenInput" rows="4" placeholder="EAAxxxx..."></textarea>
          </div>
          <button class="btn-add" id="igAddBtn" onclick="addIgAccount()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            계정 추가
          </button>
          <div id="igCandidatePicker"></div>
          <div class="add-result" id="igAddResult"></div>
        </div>
        <div class="list-panel">
          <div class="list-header">
            <span class="list-title">등록 계정</span>
            <span class="list-count" id="igListCount">-</span>
          </div>
          <div id="igAccountList"><div class="sk sk--sm"></div></div>
        </div>
      </div>`;

      initIgApiTypeToggle();

      try {
        const { accounts } = await apiFetch(`/instagram/accounts?workspaceId=${WS}`);
        _igRegisteredAccounts = Array.isArray(accounts) ? accounts : [];
        document.getElementById('igListCount').textContent = accounts.length;
        const $list = document.getElementById('igAccountList');
        if (!accounts.length) {
          $list.innerHTML = `<div class="ch-empty"><div class="text-center-muted">등록된 계정 없음</div></div>`;
        } else {
          $list.innerHTML = accounts.map(igAccountRowHTML).join('');
        }
      } catch (err) {
        _igRegisteredAccounts = [];
        document.getElementById('igAccountList').innerHTML = `<div class="state-wrap"><div class="state-title">불러오기 실패</div><div class="state-desc">${escapeHtml(err.message)}</div></div>`;
      }
    }

    function igAccountRowHTML(acc) {
      const isActive = acc.isActive !== false;
      const panelId = `ig-settings-${acc.docId}`;
      const recipients = (acc.deliveryConfig?.email?.recipients || []).join(', ');
      const emailEnabled = acc.deliveryConfig?.email?.isEnabled || false;
      const postsInitialized = acc.postsInitialized === true;
      const postsLastSynced = (() => {
        const v = acc.postsLastSyncedAt;
        if (!v) return null;
        if (typeof v === 'string') return v;
        if (typeof v === 'object') {
          const secs = v._seconds ?? v.seconds;
          if (secs != null) return new Date(secs * 1000).toISOString();
          if (typeof v.toDate === 'function') return v.toDate().toISOString();
        }
        return null;
      })();
      const selectedModel = IG_PERFORMANCE_MODELS.some(m => m.value === acc.performanceReviewModel)
        ? acc.performanceReviewModel
        : IG_PERFORMANCE_MODELS[0].value;
      const postCommentPrompt = acc.postCommentPrompt || DEFAULT_IG_POST_COMMENT_PROMPT;

      return `
      <div class="ch-row ${isActive ? '' : 'inactive'}" id="ig-row-${acc.docId}">
        <div class="ch-row-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="color:#E1306C;width:20px;height:20px">
            <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
            <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
            <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
          </svg>
        </div>
        <div class="ch-row-info">
          <div class="ch-row-name">@${escapeHtml(acc.username || acc.igUserId)}</div>
          <div class="ch-row-meta">
            ${acc.apiType === 'instagram'
              ? '<span style="display:inline-block;padding:.1rem .45rem;border-radius:4px;font-size:.7rem;font-weight:700;background:#fce4ec;color:#c2185b;margin-right:.35rem">Instagram API</span>'
              : '<span style="display:inline-block;padding:.1rem .45rem;border-radius:4px;font-size:.7rem;font-weight:700;background:#e3f2fd;color:#1565c0;margin-right:.35rem">Facebook API</span>'}
            Instagram Business${acc.pageName ? ` · ${escapeHtml(acc.pageName)}` : ''}
          </div>
          <div class="ig-debug-meta">
            <span><strong>username</strong> ${escapeHtml(acc.username || '-')}</span>
            <span><strong>igUserId</strong> ${escapeHtml(acc.igUserId || '-')}</span>
            ${acc.pageName ? `<span><strong>pageName</strong> ${escapeHtml(acc.pageName)}</span>` : ''}
          </div>
        </div>
        <div class="ch-row-status ${isActive ? 'active' : 'inactive'}">${isActive ? '활성' : '비활성'}</div>
        <div class="ch-row-actions">
          <div class="action-btn settings" id="igSettingsBtn-${acc.docId}"
               data-docid="${escapeHtml(acc.docId)}"
               onclick="toggleIgSettings(this.dataset.docid)" title="설정">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </div>
          <div class="action-btn ${isActive ? 'toggle-on' : 'toggle-off'}"
               data-docid="${escapeHtml(acc.docId)}"
               onclick="toggleIgAccount(this.dataset.docid, ${isActive})"
               title="${isActive ? '비활성화' : '활성화'}">
            ${isActive
              ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728L5.636 5.636"/></svg>`
              : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`}
          </div>
          <div class="action-btn del"
               data-docid="${escapeHtml(acc.docId)}" data-name="${escapeHtml(acc.username || acc.igUserId)}"
               onclick="deleteIgAccount(this.dataset.docid, this.dataset.name)"
               title="계정 삭제">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </div>
        </div>
      </div>
      <div class="ch-settings-panel" id="${panelId}">
        <div class="settings-section">
          <div class="settings-section-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            이메일 리포트
          </div>
          <label class="toggle-row">
            <input type="checkbox" id="igEmailEnabled-${acc.docId}" ${emailEnabled ? 'checked' : ''}
                   data-docid="${escapeHtml(acc.docId)}"
                   onchange="saveIgAccountSettings(this.dataset.docid)">
            <span style="font-size:.875rem">이메일 발송 활성화</span>
          </label>
          <textarea class="settings-textarea" id="igRecipients-${acc.docId}"
            placeholder="수신자 이메일 (쉼표 구분)">${escapeHtml(recipients)}</textarea>
          <button class="btn-save-settings" id="igSaveBtn-${acc.docId}" data-docid="${escapeHtml(acc.docId)}"
                  onclick="saveIgAccountSettings(this.dataset.docid)">저장</button>
          <div class="add-result" id="igSaveResult-${acc.docId}"></div>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            게시물 데이터
          </div>
          <div style="font-size:.8125rem;color:var(--text-muted);margin-bottom:.75rem">
            ${postsInitialized
              ? `초기화 완료${postsLastSynced ? ` · 마지막 동기화: ${postsLastSynced.slice(0, 10)}` : ''}`
              : '초기화 필요 — 아래 버튼으로 전체 게시물을 처음 수집하세요.'}
          </div>
          <button class="btn-save-settings" id="igPostsInitBtn-${acc.docId}" data-docid="${escapeHtml(acc.docId)}"
                  onclick="initIgPosts(this.dataset.docid)">${postsInitialized ? '전체 재수집' : '전체 게시물 초기화'}</button>
          <div class="add-result" id="igPostsInitResult-${acc.docId}"></div>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
            AI 성과 리뷰 지시문
          </div>
          <label class="settings-field-label" for="igPerformanceModel-${acc.docId}">AI 모델</label>
          <select class="settings-select" id="igPerformanceModel-${acc.docId}">
            ${IG_PERFORMANCE_MODELS.map(model => `
              <option value="${escapeHtml(model.value)}" ${selectedModel === model.value ? 'selected' : ''}>
                ${escapeHtml(model.label)}
              </option>
            `).join('')}
          </select>
          <textarea class="settings-textarea" id="igPerformancePrompt-${acc.docId}"
            placeholder="예: 릴스 위주로 성과를 분석하고 다음 콘텐츠 방향을 제안해줘.">${escapeHtml(acc.performanceReviewPrompt || '')}</textarea>
          <button class="btn-save-settings" id="igPerfSaveBtn-${acc.docId}" data-docid="${escapeHtml(acc.docId)}"
                  onclick="saveIgPerformancePrompt(this.dataset.docid)">저장</button>
          <div class="add-result" id="igPerformancePromptResult-${acc.docId}"></div>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8M8 14h5"/></svg>
            AI 게시물 코멘트 지시문
          </div>
          <textarea class="settings-textarea" id="igPostCommentPrompt-${acc.docId}"
            placeholder="예: 댓글 반응 톤과 최근 1주 포스트 대비 상대 성과를 중심으로 짧게 코멘트해줘.">${escapeHtml(postCommentPrompt)}</textarea>
          <button class="btn-save-settings" id="igPostCommentSaveBtn-${acc.docId}" data-docid="${escapeHtml(acc.docId)}"
                  onclick="saveIgPostCommentPrompt(this.dataset.docid)">저장</button>
          <div class="add-result" id="igPostCommentPromptResult-${acc.docId}"></div>
        </div>
      </div>`;
    }

    function findRegisteredIgAccount(igUserId) {
      return (_igRegisteredAccounts || []).find(acc => String(acc.igUserId || '') === String(igUserId || '')) || null;
    }

    function renderIgDebugCard(title, account, tone = 'neutral') {
      if (!account) return '';
      return `
        <div class="ig-debug-card ${tone}">
          <div class="ig-debug-card-title">${escapeHtml(title)}</div>
          <div class="ig-debug-card-body">
            <div><strong>username</strong><span>${escapeHtml(account.username || '-')}</span></div>
            <div><strong>igUserId</strong><span>${escapeHtml(account.igUserId || '-')}</span></div>
            <div><strong>pageName</strong><span>${escapeHtml(account.pageName || account.pageId || '-')}</span></div>
          </div>
        </div>`;
    }

    function renderIgDuplicateDebug(duplicate = {}, fallbackIgUserId = '') {
      const selected = duplicate.selected || (fallbackIgUserId ? { igUserId: fallbackIgUserId } : null);
      const existing = duplicate.existing || findRegisteredIgAccount(selected?.igUserId);
      if (!selected && !existing) return '';
      return `
        <div class="ig-debug-compare">
          <div class="ig-debug-compare-title">중복 판정 기준</div>
          <div class="ig-debug-compare-desc">이 서비스는 Meta 앱이 아니라 <code>igUserId</code> 기준으로 계정을 구분합니다.</div>
          <div class="ig-debug-compare-grid">
            ${renderIgDebugCard('이번에 선택한 계정', selected, 'selected')}
            ${renderIgDebugCard('이미 등록된 계정', existing, 'existing')}
          </div>
        </div>`;
    }

    function renderIgDuplicateResult(err, fallbackIgUserId = '') {
      const debugHtml = renderIgDuplicateDebug(err?.details?.duplicate || {}, fallbackIgUserId);
      if (!debugHtml) return '';
      return `<div class="ig-debug-result-title">${escapeHtml(err.message || '이미 등록된 계정입니다.')}</div>${debugHtml}`;
    }

    function toggleIgSettings(docId) {
      const panel = document.getElementById(`ig-settings-${docId}`);
      const btn = document.getElementById(`igSettingsBtn-${docId}`);
      const open = panel.classList.toggle('open');
      btn.classList.toggle('active', open);
    }

    function setIgApiType(type) {
      const isFacebook = type === 'facebook';
      document.getElementById('igApiTypeFacebook').style.cssText = `flex:1;padding:.5rem .75rem;border-radius:8px;font-size:.8125rem;font-weight:600;cursor:pointer;transition:all .15s;border:2px solid ${isFacebook ? 'var(--accent)' : 'var(--border)'};background:${isFacebook ? 'var(--accent)' : 'var(--bg-card)'};color:${isFacebook ? '#fff' : 'inherit'}`;
      document.getElementById('igApiTypeInstagram').style.cssText = `flex:1;padding:.5rem .75rem;border-radius:8px;font-size:.8125rem;font-weight:600;cursor:pointer;transition:all .15s;border:2px solid ${!isFacebook ? '#E1306C' : 'var(--border)'};background:${!isFacebook ? '#E1306C' : 'var(--bg-card)'};color:${!isFacebook ? '#fff' : 'inherit'}`;
      document.getElementById('igFacebookFields').style.display = isFacebook ? '' : 'none';
      document.getElementById('igApiTypeInfoText').textContent = isFacebook
        ? '토큰 발급: Meta 개발자 콘솔 → 그래프 API 탐색기 → User Token 생성 (instagram_basic, instagram_manage_insights, pages_show_list 권한 포함) → 장기 토큰(EAAxxxx)으로 교환'
        : '토큰 발급: Meta 개발자 콘솔 → Business Login for Instagram → OAuth로 Instagram User Access Token 발급 (instagram_business_basic, instagram_business_manage_messages 권한 포함)';
      document.getElementById('igTokenInput').placeholder = isFacebook ? 'EAAxxxx...' : 'Instagram User Access Token';
      document.getElementById('igTokenInput').dataset.apiType = type;
    }

    async function addIgAccount() {
      const apiType   = document.getElementById('igTokenInput').dataset.apiType || 'facebook';
      const appId     = document.getElementById('igAppIdInput').value.trim();
      const appSecret = document.getElementById('igAppSecretInput').value.trim();
      const token     = document.getElementById('igTokenInput').value.trim();
      const $picker = document.getElementById('igCandidatePicker');
      const $result = document.getElementById('igAddResult');
      const $btn = document.getElementById('igAddBtn');
      if (apiType === 'facebook') {
        if (!appId)     { $result.className = 'add-result err'; $result.textContent = '앱 ID를 입력해 주세요.'; return; }
        if (!appSecret) { $result.className = 'add-result err'; $result.textContent = '앱 시크릿을 입력해 주세요.'; return; }
      }
      if (!token)     { $result.className = 'add-result err'; $result.textContent = '액세스 토큰을 입력해 주세요.'; return; }
      _igPendingAccountSelection = null;
      if ($picker) $picker.innerHTML = '';
      $btn.disabled = true;
      $btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin .75s linear infinite"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 검증 중...`;
      $result.className = 'add-result'; $result.textContent = '';
      try {
        const body = { workspaceId: WS, accessToken: token, apiType };
        if (apiType === 'facebook') { body.appId = appId; body.appSecret = appSecret; }
        const res = await apiFetch('/instagram/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.requiresSelection && Array.isArray(res.candidates) && res.candidates.length) {
          _igPendingAccountSelection = { appId, appSecret, token, apiType, candidates: res.candidates };
          if ($picker) $picker.innerHTML = renderIgCandidatePicker(res.candidates);
          $result.className = 'add-result';
          $result.textContent = '연결된 Instagram 계정을 선택해 주세요.';
          return;
        }
        $result.className = 'add-result ok';
        $result.textContent = `@${res.username} 계정이 추가되었습니다.`;
        document.getElementById('igAppIdInput').value = '';
        document.getElementById('igAppSecretInput').value = '';
        document.getElementById('igTokenInput').value = '';
        if ($picker) $picker.innerHTML = '';
        loadIgAccounts();
      } catch (err) {
        $result.className = 'add-result err';
        const debugHtml = renderIgDuplicateResult(err);
        if (debugHtml) {
          $result.innerHTML = debugHtml;
        } else {
          $result.textContent = err.message;
        }
      } finally {
        $btn.disabled = false;
        $btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> 계정 추가`;
      }
    }

    // API 타입 토글 초기 상태 설정 (Facebook API 기본값)
    function initIgApiTypeToggle() {
      setIgApiType('facebook');
    }

    function renderIgCandidatePicker(candidates) {
      return `
        <div class="info-banner ig-picker-banner" style="margin-top:1rem;display:block">
          <div class="ig-picker-title">연결된 Instagram 계정 선택</div>
          <div class="ig-picker-desc">후보마다 <code>username</code>, <code>igUserId</code>, 연결된 Facebook Page를 확인한 뒤 선택하세요.</div>
          <div class="ig-picker-list">
            ${candidates.map((candidate) => `
              <button type="button"
                class="btn-save-settings ig-picker-btn"
                onclick="confirmIgAccountSelection('${escapeHtml(candidate.igUserId)}')">
                <span class="ig-picker-main">
                  <span class="ig-picker-account">@${escapeHtml(candidate.username || candidate.igUserId)}</span>
                  <span class="ig-picker-page">${escapeHtml(candidate.pageName || candidate.pageId || '연결된 Facebook Page 없음')}</span>
                </span>
                <span class="ig-picker-debug">
                  <span><strong>username</strong> ${escapeHtml(candidate.username || '-')}</span>
                  <span><strong>igUserId</strong> ${escapeHtml(candidate.igUserId || '-')}</span>
                </span>
              </button>`).join('')}
          </div>
        </div>`;
    }

    async function confirmIgAccountSelection(igUserId) {
      const pending = _igPendingAccountSelection;
      const $result = document.getElementById('igAddResult');
      const $picker = document.getElementById('igCandidatePicker');
      const $btn = document.getElementById('igAddBtn');
      if (!pending) return;

      $btn.disabled = true;
      $btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin .75s linear infinite"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 추가 중...`;
      try {
        const res = await apiFetch('/instagram/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: WS,
            accessToken: pending.token,
            appId: pending.appId,
            appSecret: pending.appSecret,
            igUserId,
            apiType: 'facebook',
          }),
        });
        _igPendingAccountSelection = null;
        if ($picker) $picker.innerHTML = '';
        $result.className = 'add-result ok';
        $result.textContent = `@${res.username} 계정이 추가되었습니다.`;
        document.getElementById('igAppIdInput').value = '';
        document.getElementById('igAppSecretInput').value = '';
        document.getElementById('igTokenInput').value = '';
        loadIgAccounts();
      } catch (err) {
        $result.className = 'add-result err';
        const debugHtml = renderIgDuplicateResult(err, igUserId);
        if (debugHtml) {
          $result.innerHTML = debugHtml;
        } else {
          $result.textContent = err.message;
        }
      } finally {
        $btn.disabled = false;
        $btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> 계정 추가`;
      }
    }

    async function toggleIgAccount(docId, currentActive) {
      try {
        await apiFetch(`/instagram/accounts?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !currentActive }),
        });
        loadIgAccounts();
      } catch (err) { alert('토글 실패: ' + err.message); }
    }

    async function deleteIgAccount(docId, username) {
      if (!confirm(`@${username} 계정을 삭제하시겠습니까?`)) return;
      try {
        await apiFetch(`/instagram/accounts?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'DELETE',
        });
        loadIgAccounts();
      } catch (err) { alert('삭제 실패: ' + err.message); }
    }

    async function saveIgAccountSettings(docId) {
      const isEnabled = document.getElementById(`igEmailEnabled-${docId}`)?.checked || false;
      const raw = document.getElementById(`igRecipients-${docId}`)?.value || '';
      const recipients = raw.split(',').map(s => s.trim()).filter(Boolean);
      const $res = document.getElementById(`igSaveResult-${docId}`);
      const btn = document.getElementById(`igSaveBtn-${docId}`);
      if (btn) btn.disabled = true;
      try {
        await apiFetch(`/instagram/accounts/settings?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deliveryConfig: { email: { isEnabled, recipients } } }),
        });
        if ($res) { $res.className = 'add-result ok'; $res.textContent = '저장되었습니다.'; setTimeout(() => { $res.textContent = ''; }, 2500); }
      } catch (err) {
        if ($res) { $res.className = 'add-result err'; $res.textContent = err.message; }
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function initIgPosts(docId) {
      const $res = document.getElementById(`igPostsInitResult-${docId}`);
      const btn = document.getElementById(`igPostsInitBtn-${docId}`);
      if (btn) btn.disabled = true;
      if (btn) btn.textContent = '수집 중...';
      if ($res) { $res.className = 'add-result'; $res.textContent = '전체 게시물을 수집하고 있습니다. 게시물 수에 따라 수 분이 걸릴 수 있습니다.'; }
      try {
        const result = await apiFetch('/instagram/posts/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, docId }),
        });
        if ($res) { $res.className = 'add-result ok'; $res.textContent = `완료: ${result.count}개 게시물 저장됨.`; }
        loadIgAccounts();
      } catch (err) {
        if ($res) { $res.className = 'add-result err'; $res.textContent = err.message; }
      } finally {
        if (btn) btn.disabled = false;
        if (btn) btn.textContent = '전체 재수집';
      }
    }

    async function saveIgPerformancePrompt(docId) {
      const performanceReviewPrompt = document.getElementById(`igPerformancePrompt-${docId}`)?.value || '';
      const performanceReviewModel = document.getElementById(`igPerformanceModel-${docId}`)?.value || IG_PERFORMANCE_MODELS[0].value;
      const $res = document.getElementById(`igPerformancePromptResult-${docId}`);
      const btn = document.getElementById(`igPerfSaveBtn-${docId}`);
      if (btn) btn.disabled = true;
      try {
        await apiFetch(`/instagram/accounts/settings?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ performanceReviewPrompt, performanceReviewModel }),
        });
        if ($res) { $res.className = 'add-result ok'; $res.textContent = '저장되었습니다.'; setTimeout(() => { $res.textContent = ''; }, 2500); }
      } catch (err) {
        if ($res) { $res.className = 'add-result err'; $res.textContent = err.message; }
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function saveIgPostCommentPrompt(docId) {
      const postCommentPrompt = document.getElementById(`igPostCommentPrompt-${docId}`)?.value || DEFAULT_IG_POST_COMMENT_PROMPT;
      const $res = document.getElementById(`igPostCommentPromptResult-${docId}`);
      const btn = document.getElementById(`igPostCommentSaveBtn-${docId}`);
      if (btn) btn.disabled = true;
      try {
        await apiFetch(`/instagram/accounts/settings?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postCommentPrompt }),
        });
        if ($res) { $res.className = 'add-result ok'; $res.textContent = '저장되었습니다.'; setTimeout(() => { $res.textContent = ''; }, 2500); }
      } catch (err) {
        if ($res) { $res.className = 'add-result err'; $res.textContent = err.message; }
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    /* ══════════════════════════════════════
       INSTAGRAM — 리포트
    ══════════════════════════════════════ */

    async function triggerIgReport() {
      const date = document.getElementById('igDatePicker').value;
      if (!date) { alert('날짜를 먼저 선택하세요.'); return; }

      const ok = await showConfirm({
        platform: 'instagram',
        icon: '📸',
        title: 'Instagram 파이프라인',
        color: '#E1306C',
        sub: '재실행 — 기존 리포트 덮어쓰기',
        badge: date,
        desc: 'Instagram 데이터를 다시 수집하고 리포트를 재생성합니다.',
        extraHtml: `
          <label style="display:flex;align-items:flex-start;gap:.625rem;margin-top:.25rem;padding:.85rem .95rem;border:1px solid rgba(99,102,241,.18);border-radius:12px;background:#f8faff;cursor:pointer">
            <input type="checkbox" id="confirmForceIgComments" style="margin-top:.15rem">
            <span style="font-size:.875rem;line-height:1.5;color:var(--text)">
              <strong style="color:var(--brand)">AI 코멘트 다시 생성</strong><br>
              현재 날짜 리포트에 저장된 게시물별 AI 코멘트를 무시하고, 현재 모델/프롬프트 기준으로 다시 생성합니다.
            </span>
          </label>`,
        confirmLabel: '실행',
      });
      if (!ok) return;
      const forceRegenerateComments = !!document.getElementById('confirmForceIgComments')?.checked;

      const $btn = document.getElementById('igTriggerBtn');
      const $msg = document.getElementById('igTriggerMsg');

      $btn.classList.add('spinning');
      $btn.style.pointerEvents = 'none';
      $msg.className = 'trigger-msg run show';
      $msg.textContent = '실행 중…';

      try {
        const r = await apiFetch('/instagram/pipeline/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, date, forceRegenerateComments }),
        });

        const detail = `완료 (처리: ${r.result?.processed ?? 0}, 오류: ${r.result?.errors ?? 0})`;
        $msg.className = 'trigger-msg ok show';
        $msg.textContent = '✓ ' + detail;
        setTimeout(() => loadIgReport(), 1000);
      } catch (e) {
        $msg.className = 'trigger-msg err show';
        $msg.textContent = '✗ ' + (e.message || '실패');
      } finally {
        $btn.classList.remove('spinning');
        $btn.style.pointerEvents = '';
        setTimeout(() => { $msg.classList.remove('show'); }, 6000);
      }
    }

    async function loadIgReport() {
      const $main = document.getElementById('ig-report-main');
      const date = document.getElementById('igDatePicker').value;
      if (!date) { $main.innerHTML = '<div class="state-wrap"><div class="state-desc">날짜를 선택하세요.</div></div>'; return; }

      $main.innerHTML = skeletonHTML();
      try {
        const r = await apiFetch(`/instagram/report?workspaceId=${WS}&date=${date}`);
        _igReportAllAccounts = r.accounts || [];
        populateIgReportAccountDropdown(_igReportAllAccounts);
        renderIgReportView(date);
      } catch (err) {
        handleApiError(err, $main);
      }
    }

    function populateIgReportAccountDropdown(accounts) {
      const $sel = document.getElementById('igReportAccountFilter');
      const prev = $sel.value;
      $sel.innerHTML = '<option value="all">전체</option>' +
        accounts.map(a => `<option value="${escapeHtml(a.igUserId || a.id)}">${escapeHtml(a.username || a.igUserId || a.id)}</option>`).join('');
      if ([...$sel.options].some(o => o.value === prev)) $sel.value = prev;
    }

    function filterIgReportAccount() {
      renderIgReportView(document.getElementById('igDatePicker').value);
    }

    function renderIgReportView(date) {
      const $main = document.getElementById('ig-report-main');
      const filterVal = document.getElementById('igReportAccountFilter').value;
      const accounts = filterVal === 'all'
        ? _igReportAllAccounts
        : _igReportAllAccounts.filter(a => (a.igUserId || a.id) === filterVal);

      if (!accounts.length) {
        $main.innerHTML = `<div class="state-wrap"><div class="state-title">${date} 리포트 없음</div><div class="state-desc">해당 날짜에 수집된 Instagram 데이터가 없습니다.</div></div>`;
        return;
      }
      const d = new Date(date + 'T00:00:00+09:00');
      const dateLabel = d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
      $main.innerHTML = `
        <div class="page-bar anim">
          <div class="page-date-h">${dateLabel}</div>
          <div class="page-sub">Instagram 일별 리포트 &middot; ${accounts.length}개 계정 분석</div>
        </div>
        ${accounts.map((a, i) => (i > 0 ? '<div class="ch-divider"></div>' : '') + igAccountReportHTML(a)).join('')}`;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        accounts.forEach(acc => initIgTrendChart(acc));
      }));
    }

    function renderIgTrendChart(canvasId, trendData) {
      const ctx = document.getElementById(canvasId);
      if (!ctx || !trendData || !trendData.length) return;
      new Chart(ctx, {
        data: {
          labels: trendData.map(d => d.date ? d.date.slice(5).replace('-', '/') : ''),
          datasets: [
            {
              type: 'bar',
              label: '오가닉 조회',
              data: trendData.map(d => d.dailyViews == null ? null : Math.round(Number(d.dailyViews))),
              yAxisID: 'y',
              backgroundColor: 'rgba(99,102,241,0.3)',
              borderColor: '#6366f1',
              borderWidth: 1,
            },
            {
              type: 'line',
              label: '팔로워',
              data: trendData.map(d => d.followerCount == null ? null : Math.round(Number(d.followerCount))),
              yAxisID: 'y2',
              borderColor: '#f59e0b',
              backgroundColor: 'rgba(245,158,11,0.1)',
              tension: 0.3,
              pointRadius: 3,
              pointBackgroundColor: '#f59e0b',
              spanGaps: true,
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          layout: { padding: { top: 4, right: 4, bottom: 0, left: 0 } },
          plugins: {
            legend: { position: 'top', align: 'start', labels: { boxWidth: 10, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } },
            tooltip: { bodyFont: { size: 11 }, titleFont: { size: 11 } }
          },
          scales: {
            y:  {
              position: 'left',
              title: { display: true, text: '조회', font: { size: 10 } },
              ticks: {
                font: { size: 10 },
                maxTicksLimit: 5,
                precision: 0,
                callback: (value) => Number(value).toLocaleString()
              },
              grid: { color: 'rgba(148,163,184,0.14)' }
            },
            y2: {
              position: 'right',
              title: { display: true, text: '팔로워', font: { size: 10 } },
              ticks: {
                font: { size: 10 },
                maxTicksLimit: 5,
                precision: 0,
                callback: (value) => Number(value).toLocaleString()
              },
              grid: { drawOnChartArea: false }
            },
            x: {
              ticks: { font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 },
              grid: { display: false }
            }
          }
        }
      });
    }

    function initIgTrendChart(acc) {
      const canvasId = `ig-trend-${escapeHtml(String(acc.igUserId || acc.username))}`;
      renderIgTrendChart(canvasId, acc.trendData || []);
    }

    async function loadIgAnalytics() {
      const $main = document.getElementById('ig-analytics-main');
      const startDate = document.getElementById('igAnalyticsStartDate').value;
      const endDate = document.getElementById('igAnalyticsEndDate').value;
      if (!startDate || !endDate) {
        $main.innerHTML = '<div class="state-wrap"><div class="state-desc">시작일과 종료일을 선택하세요.</div></div>';
        return;
      }

      $main.innerHTML = skeletonHTML();
      try {
        const data = await apiFetch(`/instagram/analytics?workspaceId=${WS}&startDate=${startDate}&endDate=${endDate}`);
        _igAnalyticsAccounts = data.accounts || [];

        const $sel = document.getElementById('igAnalyticsAccountFilter');
        const prev = $sel.value;
        $sel.innerHTML = '<option value="all">전체</option>' +
          _igAnalyticsAccounts.map(acc => `<option value="${escapeHtml(acc.id)}">@${escapeHtml(acc.username || acc.igUserId || acc.id)}</option>`).join('');
        if ([...$sel.options].some(o => o.value === prev)) $sel.value = prev;

        renderIgAnalyticsView(startDate, endDate);
      } catch (err) {
        handleApiError(err, $main);
      }
    }

    function filterIgAnalyticsAccount() {
      const startDate = document.getElementById('igAnalyticsStartDate').value;
      const endDate = document.getElementById('igAnalyticsEndDate').value;
      renderIgAnalyticsView(startDate, endDate);
    }

    function renderIgAnalyticsView(startDate, endDate) {
      const $main = document.getElementById('ig-analytics-main');
      const filterVal = document.getElementById('igAnalyticsAccountFilter').value;
      const accounts = filterVal === 'all'
        ? _igAnalyticsAccounts
        : _igAnalyticsAccounts.filter(acc => acc.id === filterVal);

      if (!accounts.length) {
        $main.innerHTML = '<div class="state-wrap"><div class="state-title">데이터 없음</div><div class="state-desc">해당 기간에 조회할 Instagram 데이터가 없습니다.</div></div>';
        return;
      }

      const d1 = new Date(startDate + 'T00:00:00+09:00');
      const d2 = new Date(endDate + 'T00:00:00+09:00');
      const fmtKo = d => d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
      const dateRange = `${fmtKo(d1)} ~ ${fmtKo(d2)}`;

      $main.innerHTML = `
        <div class="page-bar anim">
          <div class="page-date-h">${dateRange}</div>
          <div class="page-sub">Instagram 커스텀 분석 &middot; ${accounts.length}개 계정</div>
        </div>
        ${accounts.map((acc, i) => (i > 0 ? '<div class="ch-divider"></div>' : '') + igAnalyticsAccountHTML(acc)).join('')}`;

      requestAnimationFrame(() => requestAnimationFrame(() => {
        accounts.forEach(acc => {
          renderIgTrendChart(`ig-custom-trend-${escapeHtml(String(acc.igUserId || acc.username || acc.id))}`, acc.trendChart || []);
        });
      }));
    }

    const SVG_IG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`;
    const SVG_USERS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
    const SVG_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const SVG_HEART = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
    const SVG_GRID = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`;
    const SVG_TRENDING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`;
    const SVG_AWARD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>`;

    function igAccountReportHTML(acc) {
      const posts = acc.posts || [];
      const tableId = `ig-daily-comments-${String(acc.id || acc.igUserId || acc.username || 'account').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const commentRowCount = posts.filter(p =>
        p.aiCommentStatus === 'waiting_1d' || (p.aiCommentStatus === 'commented' && p.aiComment)
      ).length;

      const perfBlock = acc.aiPerformanceReview
        ? (() => {
            const lines = acc.aiPerformanceReview.split('\n').filter(l => l.trim());
            const linesHtml = lines.map(l => `<div style="margin-bottom:4px">${sanitizeReportHtml(l)}</div>`).join('');
            return `<div class="scard anim d5">
              <div class="slabel"><div class="slabel-dot"></div>${SVG_GRID}AI 성과 리뷰 <span class="slabel-count">최근 1주 포스트 종합</span></div>
              <div style="font-size:.8125rem;color:var(--text);line-height:1.6">${linesHtml}</div>
            </div>`;
          })()
        : '';

      return `
      <div class="ch-header anim d1">
        <div class="ch-platform-icon" style="color:#E1306C">${SVG_IG}</div>
        <div>
          <div class="ch-name">@${escapeHtml(acc.username || acc.igUserId)}</div>
          <div class="ch-id">Instagram &middot; 최근 7일 포스트 ${posts.length}개</div>
        </div>
      </div>

      <div class="scard anim d2">
        <div class="slabel"><div class="slabel-dot"></div>${SVG_TRENDING}팔로워 · 조회 트렌드</div>
        ${(acc.trendData && acc.trendData.length > 0)
          ? `<div class="ig-trend-chart-shell">
              <canvas id="ig-trend-${escapeHtml(String(acc.igUserId || acc.username))}"></canvas>
            </div>`
          : '<div style="font-size:.875rem;color:var(--text-3);padding:.5rem 0">트렌드 데이터 수집 중...</div>'}
      </div>

      <div class="scard anim d4">
        <div class="slabel slabel-with-actions">
          <div class="slabel-main"><div class="slabel-dot"></div>${SVG_GRID}최근 게시물 <span class="slabel-count">${posts.length}건</span></div>
          ${renderIgCommentToolbarHTML(tableId, commentRowCount)}
        </div>
        ${igPostTableHTML(posts, { enableCommentControls: true, tableId })}
      </div>

      ${perfBlock}

      ${(acc.model || acc.totalTokens) ? `
      <div class="token-info-strip anim d6">
        ${acc.model ? `<span class="token-model">${escapeHtml(acc.model)}</span>` : ''}
        ${acc.totalTokens ? `<span>입력 ${(acc.promptTokens || 0).toLocaleString()} / 출력 ${(acc.completionTokens || 0).toLocaleString()} / 합계 ${(acc.totalTokens || 0).toLocaleString()} 토큰</span>` : ''}
        ${acc.cost != null ? `<span>비용 $${Number(acc.cost).toFixed(4)}</span>` : ''}
      </div>` : ''}`;
    }

    function igAnalyticsAccountHTML(acc) {
      const posts = acc.posts || [];
      const trendRows = acc.trendChart || [];
      const hasTrendData = trendRows.some(row => row.followerCount != null || row.dailyViews != null);
      const tableId = `ig-comments-${String(acc.id || acc.igUserId || acc.username || 'account').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const commentRowCount = posts.filter(p => p.aiCommentStatus === 'commented' && p.aiComment).length;

      return `
      <div class="ch-header anim d1">
        <div class="ch-platform-icon" style="color:#E1306C">${SVG_IG}</div>
        <div>
          <div class="ch-name">@${escapeHtml(acc.username || acc.igUserId || acc.id)}</div>
          <div class="ch-id">Instagram &middot; 기간 내 게시물 ${posts.length}개</div>
        </div>
      </div>

      <div class="scard anim d2">
        <div class="slabel"><div class="slabel-dot"></div>${SVG_TRENDING}팔로워 · 조회 트렌드</div>
        ${hasTrendData
          ? `<div class="ig-trend-chart-shell">
              <canvas id="ig-custom-trend-${escapeHtml(String(acc.igUserId || acc.username || acc.id))}"></canvas>
            </div>`
          : '<div style="font-size:.875rem;color:var(--text-3);padding:.5rem 0">해당 기간의 트렌드 데이터가 없습니다.</div>'}
      </div>

      <div class="scard anim d4">
        <div class="slabel slabel-with-actions">
          <div class="slabel-main"><div class="slabel-dot"></div>${SVG_GRID}기간 내 게시물 <span class="slabel-count">${posts.length}건</span></div>
          ${renderIgCommentToolbarHTML(tableId, commentRowCount)}
        </div>
        ${igPostTableHTML(posts, { hidePendingAiComment: true, enableCommentControls: true, tableId })}
      </div>`;
    }

    function renderIgCommentToolbarHTML(tableId, commentRowCount) {
      return `<div class="ig-comment-toolbar-actions">
        <button type="button" class="ig-comment-bulk-btn" id="ig-comment-collapse-all-${tableId}"
          onclick="setIgCommentTableVisibility('${escapeHtml(tableId)}', false)" ${commentRowCount ? '' : 'disabled'}>일괄 접기</button>
        <button type="button" class="ig-comment-bulk-btn" id="ig-comment-expand-all-${tableId}"
          onclick="setIgCommentTableVisibility('${escapeHtml(tableId)}', true)" disabled>일괄 펼치기</button>
      </div>`;
    }

    function setIgCommentRowVisible(rowKey, visible) {
      const row = document.getElementById(`ig-comment-row-${rowKey}`);
      const btn = document.getElementById(`ig-comment-toggle-${rowKey}`);
      if (!row) return;
      row.classList.toggle('ig-comment-row-hidden', !visible);
      if (btn && !btn.disabled) {
        btn.textContent = visible ? '코멘트 접기' : '코멘트 펼치기';
        btn.classList.toggle('collapsed', !visible);
      }
    }

    function syncIgCommentTableControls(tableId) {
      const rows = [...document.querySelectorAll(`[data-ig-comment-table="${tableId}"]`)];
      const collapseBtn = document.getElementById(`ig-comment-collapse-all-${tableId}`);
      const expandBtn = document.getElementById(`ig-comment-expand-all-${tableId}`);
      const visibleCount = rows.filter(row => !row.classList.contains('ig-comment-row-hidden')).length;

      if (collapseBtn) collapseBtn.disabled = !rows.length || visibleCount === 0;
      if (expandBtn) expandBtn.disabled = !rows.length || visibleCount === rows.length;
    }

    function toggleIgCommentRow(tableId, rowKey) {
      const row = document.getElementById(`ig-comment-row-${rowKey}`);
      if (!row) return;
      const willShow = row.classList.contains('ig-comment-row-hidden');
      setIgCommentRowVisible(rowKey, willShow);
      syncIgCommentTableControls(tableId);
    }

    function setIgCommentTableVisibility(tableId, visible) {
      const rows = [...document.querySelectorAll(`[data-ig-comment-table="${tableId}"]`)];
      rows.forEach(row => {
        const rowKey = row.dataset.igCommentRow;
        if (rowKey) setIgCommentRowVisible(rowKey, visible);
      });
      syncIgCommentTableControls(tableId);
    }

    function buildIgPostCommentHTML(post, options = {}) {
      if (!post) return '';
      const hidePendingAiComment = options.hidePendingAiComment === true;
      const rowKey = options.rowKey || '';
      const tableId = options.tableId || '';
      if (!hidePendingAiComment && post.aiCommentStatus === 'waiting_1d') {
        return `<tr id="ig-comment-row-${rowKey}" class="ig-comment-row" data-ig-comment-table="${escapeHtml(tableId)}" data-ig-comment-row="${escapeHtml(rowKey)}">
          <td colspan="10" style="padding:0 8px 12px 8px;border-bottom:1px solid var(--border)">
            <div style="margin:8px 0 0 24px;padding:10px 12px;border-radius:12px;background:#fff7ed;border:1px solid #fdba74">
              <div style="font-size:.625rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c2410c;margin-bottom:6px">분석 대기</div>
              <div style="font-size:.75rem;line-height:1.65;color:#9a3412">1일 대기 중. 게시 후 하루가 지난 다음 리포트에서 댓글 반응과 성과를 함께 분석합니다.</div>
            </div>
          </td>
        </tr>`;
      }
      if (post.aiCommentStatus === 'commented' && post.aiComment) {
        return `<tr id="ig-comment-row-${rowKey}" class="ig-comment-row" data-ig-comment-table="${escapeHtml(tableId)}" data-ig-comment-row="${escapeHtml(rowKey)}">
          <td colspan="10" style="padding:0 8px 12px 8px;border-bottom:1px solid var(--border)">
            <div style="margin:8px 0 0 24px;padding:10px 12px;border-radius:12px;background:#f5f7ff;border:1px solid #c7d2fe">
              <div style="font-size:.625rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6366f1;margin-bottom:6px">AI 코멘트</div>
              <div style="font-size:.75rem;line-height:1.7;color:var(--text)">${escapeHtml(post.aiComment)}</div>
            </div>
          </td>
        </tr>`;
      }
      return '';
    }

    function igPostTableHTML(posts, options = {}) {
      if (!posts || !posts.length) return '<div style="color:var(--text-2);font-size:.875rem;padding:.5rem 0">포스트 없음</div>';
      const includeAiComments = options.includeAiComments !== false;
      const hidePendingAiComment = options.hidePendingAiComment === true;
      const enableCommentControls = options.enableCommentControls === true;
      const tableId = options.tableId || `ig-comments-${Date.now()}`;
      const MEDIA_LABELS = { IMAGE: '사진', VIDEO: '영상', REELS: '영상', CAROUSEL_ALBUM: '슬라이드' };
      const DOW_KO = ['일','월','화','수','목','금','토'];
      const rows = posts.map((p, idx) => {
        const er = p.engagementRate ?? 0;
        const erColor = er >= 5 ? '#059669' : er >= 2 ? '#d97706' : '#94a3b8';
        const hasCommentRow = includeAiComments && ((!hidePendingAiComment && p.aiCommentStatus === 'waiting_1d') || (p.aiCommentStatus === 'commented' && p.aiComment));
        const rowKey = `${tableId}-${idx}`;

        // KST 날짜: UTC+9 offset으로 계산
        let dateStr = '-';
        if (p.timestamp) {
          const dtKST = new Date(new Date(p.timestamp).getTime() + 9 * 60 * 60 * 1000);
          const m   = dtKST.getUTCMonth() + 1;
          const d   = dtKST.getUTCDate();
          const dow = DOW_KO[dtKST.getUTCDay()];
          dateStr = `${m}/${d}(${dow})`;
        }

        // 본문 (caption 앞 20자 + permalink 링크)
        const captionRaw = p.caption ? p.caption.substring(0, 20) + (p.caption.length > 20 ? '…' : '') : '';
        const captionEsc = escapeHtml(captionRaw);
        const captionCell = p.permalink && p.permalink.startsWith('https://')
          ? `<a href="${escapeHtml(p.permalink)}" target="_blank" rel="noopener noreferrer" style="color:var(--brand);text-decoration:none">${captionEsc || '↗'}</a>`
          : captionEsc;
        const commentToggleBtn = enableCommentControls
          ? `<button type="button"
              class="ig-comment-toggle-btn${hasCommentRow ? '' : ' disabled'}"
              id="ig-comment-toggle-${rowKey}"
              ${hasCommentRow ? `onclick="toggleIgCommentRow('${escapeHtml(tableId)}','${escapeHtml(rowKey)}')"` : 'disabled'}
            >${hasCommentRow ? '코멘트 접기' : '코멘트 없음'}</button>`
          : '';
        const bodyCell = enableCommentControls
          ? `<div class="ig-post-cell-wrap">
              <span class="ig-post-cell-text" title="${p.caption ? escapeHtml(p.caption) : ''}">${captionCell}</span>
              ${commentToggleBtn}
            </div>`
          : captionCell;

        const mtRaw = (p.mediaType || p.media_type || '').toUpperCase();
        const mt = mtRaw === 'REELS' ? 'VIDEO' : mtRaw;
        const typeLabel = MEDIA_LABELS[mt] || escapeHtml(mt || '-');

        // 조회: 실제 views API값, fallback reach
        const views = p.views != null ? p.views.toLocaleString() : (p.reach != null ? p.reach.toLocaleString() : '-');

        const baseRow = `<tr>
          <td style="white-space:nowrap">${dateStr}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.75rem">${bodyCell}</td>
          <td><span style="font-size:.6875rem;padding:2px 5px;border-radius:4px;background:var(--surface-2);color:var(--text-2)">${typeLabel}</span></td>
          <td>${views}</td>
          <td>${p.likes != null ? p.likes.toLocaleString() : '-'}</td>
          <td>${p.comments != null ? p.comments.toLocaleString() : '-'}</td>
          <td>${p.shares != null ? p.shares.toLocaleString() : '-'}</td>
          <td>${p.saves != null ? p.saves.toLocaleString() : '-'}</td>
          <td>${p.profileVisits != null ? p.profileVisits.toLocaleString() : '-'}</td>
          <td style="color:${erColor};font-weight:600">${er}%</td>
        </tr>`;
        return baseRow + (includeAiComments ? buildIgPostCommentHTML(p, { hidePendingAiComment, rowKey, tableId }) : '');
      }).join('');
      return `<div style="overflow-x:auto;margin-top:.75rem">
        <table class="data-table" style="font-size:.75rem">
          <thead><tr>
            <th>날짜</th><th>본문</th><th>유형</th><th>조회</th>
            <th>좋아요</th><th>댓글</th><th>공유</th><th>저장</th>
            <th>프로필방문</th><th>참여율</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

    /* ══════════════════════════════════════
       INSTAGRAM — 토큰 관리
    ══════════════════════════════════════ */

    async function loadIgTokens() {
      const $main = document.getElementById('ig-tokens-main');
      $main.innerHTML = skeletonHTML();
      try {
        const { accounts } = await apiFetch(`/instagram/tokens?workspaceId=${WS}`);
        if (!accounts || !accounts.length) {
          $main.innerHTML = `<div class="state-wrap"><div class="state-title">등록된 계정 없음</div><div class="state-desc">계정 관리에서 Instagram 계정을 먼저 추가해 주세요.</div></div>`;
          return;
        }
        $main.innerHTML = `
          <div class="info-banner" style="margin-bottom:1.5rem">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>파이프라인이 매일 KST 09:00에 실행될 때 만료 7일 이내 토큰을 자동으로 갱신합니다.</span>
          </div>
          <div style="overflow-x:auto">
            <table class="data-table">
              <thead><tr>
                <th>계정</th><th>상태</th><th>만료일</th><th>남은 일수</th><th>마지막 갱신</th><th>액션</th>
              </tr></thead>
              <tbody>${accounts.map(igTokenRowHTML).join('')}</tbody>
            </table>
          </div>`;
      } catch (err) {
        handleApiError(err, $main);
      }
    }

    function igTokenRowHTML(acc) {
      const statusMap = { active: { text: '활성', color: '#059669' }, expiring_soon: { text: '만료 임박', color: '#d97706' }, expired: { text: '만료됨', color: '#ef4444' } };
      const s = statusMap[acc.status] || { text: acc.status, color: '#94a3b8' };
      const expiresStr = acc.tokenExpiresAt ? new Date(
        typeof acc.tokenExpiresAt === 'object' && acc.tokenExpiresAt._seconds
          ? acc.tokenExpiresAt._seconds * 1000
          : acc.tokenExpiresAt
      ).toLocaleDateString('ko-KR') : '-';
      const refreshedStr = acc.tokenRefreshedAt ? new Date(
        typeof acc.tokenRefreshedAt === 'object' && acc.tokenRefreshedAt._seconds
          ? acc.tokenRefreshedAt._seconds * 1000
          : acc.tokenRefreshedAt
      ).toLocaleDateString('ko-KR') : '-';
      const daysStr = acc.daysUntilExpiry != null ? (acc.daysUntilExpiry < 0 ? '만료됨' : `${acc.daysUntilExpiry}일`) : '-';
      const safeDocId = escapeHtml(acc.docId);
      return `<tr>
        <td>@${escapeHtml(acc.username || acc.igUserId || '')}</td>
        <td><span style="color:${s.color};font-weight:600">${s.text}</span></td>
        <td>${expiresStr}</td>
        <td>${daysStr}</td>
        <td>${refreshedStr}</td>
        <td style="display:flex;gap:.375rem;align-items:center;flex-wrap:wrap">
          <button class="btn-save-settings" style="padding:.25rem .75rem;font-size:.8125rem" data-docid="${safeDocId}" onclick="refreshIgToken(this.dataset.docid)">갱신</button>
          <button class="btn-save-settings" style="padding:.25rem .75rem;font-size:.8125rem;background:var(--surface2)" data-docid="${safeDocId}" onclick="checkIgToken(this.dataset.docid, this)">상태 확인</button>
          <span id="ig-check-result-${safeDocId}" style="font-size:.8125rem"></span>
        </td>
      </tr>`;
    }

    async function refreshIgToken(docId) {
      try {
        const res = await apiFetch(`/instagram/tokens/refresh?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'POST',
        });
        alert(`토큰 갱신 완료: @${res.username}\n새 만료일: ${new Date(res.newExpiresAt).toLocaleDateString('ko-KR')}`);
        loadIgTokens();
      } catch (err) {
        alert('토큰 갱신 실패: ' + err.message);
      }
    }

    async function checkIgToken(docId, btn) {
      const $result = document.getElementById(`ig-check-result-${docId}`);
      if (!$result) return;
      btn.disabled = true;
      $result.style.color = '#94a3b8';
      $result.textContent = '확인 중…';
      try {
        const res = await apiFetch(`/instagram/tokens/check?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'POST',
        });
        if (res.valid) {
          $result.style.color = '#059669';
          $result.textContent = '✓ 유효';
        } else {
          $result.style.color = '#ef4444';
          $result.textContent = '✗ 무효';
        }
      } catch (err) {
        $result.style.color = '#ef4444';
        $result.textContent = '오류';
      } finally {
        btn.disabled = false;
      }
    }

    // ════════════════════════════════════════════════════════
    //  Facebook 그룹 관리
    // ════════════════════════════════════════════════════════

    // ── 날짜 목록 새로고침 ─────────────────────────────────────
    async function refreshFbAvailableDates() {
      try {
        const { dates } = await apiFetch(`/facebook/available-dates?workspaceId=${WS}`);
        if (!dates.length) return;
        if (_fpFbDatePicker) {
          _fpFbDatePicker.set('enable', dates);
          if (!_fpFbDatePicker.selectedDates.length) _fpFbDatePicker.setDate(dates[0], false);
        } else {
          // Flatpickr 아직 미초기화 상태면 raw input 직접 세팅
          const input = document.getElementById('fbReportDate');
          if (input && !input.value) input.value = dates[0];
        }
      } catch (_) {}
    }

    async function refreshFbPageAvailableDates() {
      try {
        const { dates } = await apiFetch(`/facebook/page/available-dates?workspaceId=${WS}`);
        _availableFbPageDates = dates || [];
        if (!dates.length) return;
        if (_fpFbPageDatePicker) {
          _fpFbPageDatePicker.set('enable', dates);
          if (!_fpFbPageDatePicker.selectedDates.length) _fpFbPageDatePicker.setDate(dates[0], false);
        } else {
          const input = document.getElementById('fbPageReportDate');
          if (input && !input.value) input.value = dates[0];
        }
      } catch (_) {}
    }

    // ── 수동 트리거 ───────────────────────────────────────────
    async function triggerFbReport() {
      const date = document.getElementById('fbReportDate')?.value;
      if (!date) { alert('날짜를 먼저 선택하세요.'); return; }

      const ok = await showConfirm({
        platform: 'facebook',
        icon: '📘',
        title: 'Facebook 파이프라인',
        color: '#1877f2',
        sub: '재실행 — 기존 리포트 덮어쓰기',
        badge: date,
        desc: 'Facebook 그룹 데이터를 다시 수집하고 리포트를 재생성합니다.',
        confirmLabel: '실행',
      });
      if (!ok) return;

      const $btn = document.getElementById('fbTriggerBtn');
      const $msg = document.getElementById('fbTriggerMsg');

      $btn.classList.add('spinning');
      $btn.style.pointerEvents = 'none';
      $msg.className = 'trigger-msg run show';
      $msg.textContent = '실행 중…';

      try {
        const r = await apiFetch('/facebook/pipeline/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, date }),
        });

        const detail = `완료 (처리: ${r.results?.processed ?? 0}, 오류: ${r.results?.errors ?? 0})`;
        $msg.className = 'trigger-msg ok show';
        $msg.textContent = '✓ ' + detail;
        setTimeout(() => loadFbReport(), 1000);
      } catch (e) {
        $msg.className = 'trigger-msg err show';
        $msg.textContent = '✗ ' + (e.message || '실패');
      } finally {
        $btn.classList.remove('spinning');
        $btn.style.pointerEvents = '';
        setTimeout(() => { $msg.classList.remove('show'); }, 6000);
      }
    }

    const SVG_FB = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>`;

    // ── 리포트 조회 ───────────────────────────────────────────
    async function loadFbReport() {
      const $main = document.getElementById('fb-report-main');
      if (!$main) return;
      const date = document.getElementById('fbReportDate')?.value;
      if (!date) { $main.innerHTML = '<div class="empty-state">날짜를 선택하세요.</div>'; return; }
      $main.innerHTML = skeletonHTML();
      try {
        const { reports } = await apiFetch(`/facebook/report?workspaceId=${WS}&date=${encodeURIComponent(date)}`);
        if (!reports || reports.length === 0) {
          $main.innerHTML = `<div class="empty-state">${date} 리포트가 없습니다.</div>`;
          return;
        }
        $main.innerHTML = reports.map((r, i) => (i > 0 ? '<div class="ch-divider"></div>' : '') + buildFbReportCard(r)).join('');
      } catch (err) {
        $main.innerHTML = `<div class="error-state">오류: ${err.message}</div>`;
      }
    }

    function buildFbReportCard(r) {
      const crawlBadge = r.crawlStatus === 'partial'
        ? `<div class="badge alert">${SVG.warn} 부분 수집</div>`
        : r.crawlStatus === 'failed'
        ? `<div class="badge alert">${SVG.warn} 수집 오류</div>`
        : '';
      const issues = (r.aiIssues || []).map(issue => {
        const postUrl = issue.postIndex ? r.posts?.[issue.postIndex - 1]?.postUrl : null;
        const link = postUrl
          ? `<a href="${postUrl}" target="_blank" class="issue-msg-link" title="게시글 보기">↗</a>`
          : '';
        return `
        <div style="padding:10px 12px;background:#fff7ed;border-left:3px solid #f97316;border-radius:0 8px 8px 0;margin-bottom:6px">
          <div style="font-size:13px;font-weight:600;color:#c2410c">${issue.title || ''}${link}</div>
          <div style="font-size:12px;color:#78350f;margin-top:3px">${issue.description || ''}</div>
        </div>`;
      }).join('');
      return `
      <div class="ch-header anim d1">
        <div class="ch-platform-icon" style="color:#1877f2">${SVG_FB}</div>
        <div>
          <div class="ch-name">${escapeHtml(r.groupName || '')}</div>
          <div class="ch-id">Facebook Group &middot; 게시글 ${r.postCount||0}개 &middot; 반응 ${(r.totalReactions||0).toLocaleString()} &middot; 댓글 ${(r.totalComments||0).toLocaleString()}</div>
        </div>
        <div class="ch-badges">${crawlBadge}</div>
      </div>

      ${r.aiSummary ? `<div class="scard anim d2">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.doc}AI 동향 요약</div>
        <div style="font-size:.8125rem;color:var(--text);line-height:1.8">${sanitizeReportHtml(r.aiSummary)}</div>
      </div>` : ''}

      <div class="scard anim d3">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.warn}주요 이슈</div>
        ${issues || '<div style="color:var(--text-3);font-size:.875rem;line-height:1.8">오늘은 별도로 부각된 주요 이슈가 감지되지 않았습니다.</div>'}
      </div>

      ${(r.model || r.totalTokens) ? `
      <div class="token-info-strip anim d4">
        ${r.model ? `<span class="token-model">${escapeHtml(r.model)}</span>` : ''}
        ${r.totalTokens ? `<span>입력 ${(r.promptTokens || 0).toLocaleString()} / 출력 ${(r.completionTokens || 0).toLocaleString()} / 합계 ${(r.totalTokens || 0).toLocaleString()} 토큰</span>` : ''}
        ${r.cost != null ? `<span>비용 $${Number(r.cost).toFixed(4)}</span>` : ''}
      </div>` : ''}`;
    }

    // ── 그룹 관리 ─────────────────────────────────────────────
    async function loadFbGroups() {
      const $main = document.getElementById('fb-groups-main');
      if (!$main) return;

      // 스켈레톤
      $main.innerHTML = `
        <div class="ch-mgmt-grid">
          <div class="add-panel">
            <div class="panel-title">그룹 추가</div>
            <div class="panel-desc">모니터링할 공개 Facebook 그룹 URL을 등록합니다.</div>
            <div class="field-group">
              <label class="field-label">그룹 이름 <span class="text-neg">*</span></label>
              <input class="field-input" id="fbGroupNameInput" type="text" placeholder="예: 안티그래비티 팬 그룹" autocomplete="off">
            </div>
            <div class="field-group">
              <label class="field-label">그룹 URL <span class="text-neg">*</span></label>
              <input class="field-input" id="fbGroupUrlInput" type="text" placeholder="https://www.facebook.com/groups/..." autocomplete="off">
            </div>
            <button class="btn-add" onclick="addFbGroup()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              그룹 추가
            </button>
            <div class="add-result" id="fbAddResult"></div>
          </div>
          <div class="list-panel">
            <div class="list-header">
              <span class="list-title">등록된 그룹</span>
              <span class="list-count" id="fbGroupListCount">-</span>
            </div>
            <div id="fb-group-list"><div class="sk sk--sm"></div></div>
          </div>
        </div>`;

      try {
        const { groups } = await apiFetch(`/facebook/groups?workspaceId=${WS}`);
        document.getElementById('fbGroupListCount').textContent = groups.length;
        const $list = document.getElementById('fb-group-list');
        $list.innerHTML = groups.length === 0
          ? '<div class="ch-empty"><div class="text-center-muted">등록된 그룹 없음</div></div>'
          : groups.map(g => fbGroupRowHTML(g)).join('');
      } catch (err) {
        document.getElementById('fb-group-list').innerHTML =
          `<div class="state-wrap"><div class="state-title">불러오기 실패</div><div class="state-desc">${escapeHtml(err.message)}</div></div>`;
      }
    }

    function fbGroupRowHTML(g) {
      const isActive = g.isActive !== false;
      const recipients = (g.deliveryConfig?.email?.recipients || []).join(', ');
      const isEmailEnabled = g.deliveryConfig?.email?.isEnabled ?? false;
      const panelId = `fb-settings-${g.docId}`;
      const selectedModel = FB_ANALYSIS_MODELS.some(m => m.value === g.analysisModel)
        ? g.analysisModel
        : FB_ANALYSIS_MODELS[0].value;

      return `
        <div class="ch-row ${isActive ? '' : 'inactive'}" id="fb-row-${g.docId}">
          <div class="ch-row-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;color:#1877F2">
              <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97h-1.513c-1.491 0-1.956.93-1.956 1.886v2.267h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/>
            </svg>
          </div>
          <div class="ch-row-info">
            <div class="ch-row-name">${escapeHtml(g.groupName || g.groupId)}</div>
            <div class="ch-row-meta">Facebook Group</div>
          </div>
          <div class="ch-row-status ${isActive ? 'active' : 'inactive'}">${isActive ? '활성' : '비활성'}</div>
          <div class="ch-row-actions">
            <div class="action-btn settings" data-docid="${escapeHtml(g.docId)}"
                 onclick="toggleFbGroupSettings(this.dataset.docid)" title="설정">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </div>
            <div class="action-btn ${isActive ? 'toggle-on' : 'toggle-off'}"
                 data-docid="${escapeHtml(g.docId)}"
                 onclick="toggleFbGroup(this.dataset.docid, ${isActive})"
                 title="${isActive ? '비활성화' : '활성화'}">
              ${isActive
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728L5.636 5.636"/></svg>`
                : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`}
            </div>
            <div class="action-btn del"
                 data-docid="${escapeHtml(g.docId)}" data-name="${escapeHtml(g.groupName || g.groupId)}"
                 onclick="deleteFbGroup(this.dataset.docid, this.dataset.name)"
                 title="그룹 삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </div>
          </div>
        </div>
        <div class="ch-settings-panel" id="${panelId}">
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              이메일 리포트
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="fbEmailEnabled-${g.docId}" ${isEmailEnabled ? 'checked' : ''}>
              <span style="font-size:.875rem">이메일 발송 활성화</span>
            </label>
            <textarea class="settings-textarea" id="fbRecipients-${g.docId}"
              placeholder="수신자 이메일 (쉼표 구분)">${escapeHtml(recipients)}</textarea>
            <button class="btn-save-settings" data-docid="${escapeHtml(g.docId)}"
                    onclick="saveFbGroupSettings(this.dataset.docid)">저장</button>
            <div class="add-result" id="fbSaveResult-${g.docId}"></div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
              AI 분석 지시문
            </div>
            <label class="settings-field-label" for="fbAnalysisModel-${g.docId}">AI 모델</label>
            <select class="settings-select" id="fbAnalysisModel-${g.docId}">
              ${FB_ANALYSIS_MODELS.map(m => `
                <option value="${escapeHtml(m.value)}" ${selectedModel === m.value ? 'selected' : ''}>
                  ${escapeHtml(m.label)}
                </option>
              `).join('')}
            </select>
            <textarea class="settings-textarea" id="fbAnalysisPrompt-${g.docId}"
              rows="3" placeholder="예: 부정적 반응 위주로 분석해줘. 이슈 항목은 최대 3개로 제한해줘.">${escapeHtml(g.analysisPrompt || '')}</textarea>
            <button class="btn-save-settings" data-docid="${escapeHtml(g.docId)}"
                    onclick="saveFbGroupSettings(this.dataset.docid)">저장</button>
          </div>
        </div>`;
    }

    function toggleFbGroupSettings(docId) {
      const panel = document.getElementById(`fb-settings-${docId}`);
      if (panel) panel.classList.toggle('open');
    }

    async function addFbGroup() {
      const groupUrl  = document.getElementById('fbGroupUrlInput')?.value.trim();
      const groupName = document.getElementById('fbGroupNameInput')?.value.trim();
      if (!groupUrl) { alert('그룹 URL을 입력하세요.'); return; }
      try {
        await apiFetch('/facebook/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, groupUrl, groupName }),
        });
        await loadFbGroups();
      } catch (err) { alert('그룹 추가 실패: ' + err.message); }
    }

    async function toggleFbGroup(docId, currentActive) {
      try {
        await apiFetch(`/facebook/groups?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !currentActive }),
        });
        await loadFbGroups();
      } catch (err) { alert('상태 변경 실패: ' + err.message); }
    }

    async function saveFbGroupSettings(docId) {
      const isEnabled  = document.getElementById(`fbEmailEnabled-${docId}`)?.checked ?? false;
      const recipients = (document.getElementById(`fbRecipients-${docId}`)?.value || '')
        .split(/[,\n]/).map(e => e.trim()).filter(Boolean);
      const analysisPrompt = document.getElementById(`fbAnalysisPrompt-${docId}`)?.value || '';
      const analysisModel = document.getElementById(`fbAnalysisModel-${docId}`)?.value || FB_ANALYSIS_MODELS[0].value;
      const $result = document.getElementById(`fbSaveResult-${docId}`);
      try {
        await apiFetch(`/facebook/groups/settings?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deliveryConfig: { email: { isEnabled, recipients } },
            analysisPrompt,
            analysisModel,
          }),
        });
        if ($result) { $result.textContent = '✓ 저장됨'; $result.style.color = 'var(--pos)'; setTimeout(() => { if ($result) $result.textContent = ''; }, 2000); }
        await loadFbGroups();
      } catch (err) {
        if ($result) { $result.textContent = '저장 실패: ' + err.message; $result.style.color = 'var(--neg)'; }
      }
    }

    async function deleteFbGroup(docId, groupName) {
      const ok = await confirmDialog(`그룹 "${groupName}"을 삭제하시겠습니까?\n관련 리포트도 함께 삭제됩니다.`);
      if (!ok) return;
      try {
        await apiFetch(`/facebook/groups?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, { method: 'DELETE' });
        await loadFbGroups();
      } catch (err) { alert('삭제 실패: ' + err.message); }
    }

    // ── 페이지 리포트 ───────────────────────────────────────────
    async function triggerFbPageReport() {
      const date = document.getElementById('fbPageReportDate')?.value;
      if (!date) { alert('날짜를 먼저 선택하세요.'); return; }

      const ok = await showConfirm({
        platform: 'facebook',
        icon: '📘',
        title: 'Facebook 페이지 파이프라인',
        color: '#1877f2',
        sub: '재실행 — 기존 리포트 덮어쓰기',
        badge: date,
        desc: 'Facebook 페이지 게시물과 댓글 데이터를 다시 수집하고 리포트를 재생성합니다.',
        confirmLabel: '실행',
      });
      if (!ok) return;

      const $btn = document.getElementById('fbPageTriggerBtn');
      const $msg = document.getElementById('fbPageTriggerMsg');

      $btn.classList.add('spinning');
      $btn.style.pointerEvents = 'none';
      $msg.className = 'trigger-msg run show';
      $msg.textContent = '실행 중...';

      try {
        const r = await apiFetch('/facebook/page/pipeline/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, date }),
        });

        const detail = `완료 (처리: ${r.results?.processed ?? 0}, 오류: ${r.results?.errors ?? 0})`;
        $msg.className = 'trigger-msg ok show';
        $msg.textContent = '✓ ' + detail;
        setTimeout(() => loadFbPageReport(), 1000);
      } catch (e) {
        $msg.className = 'trigger-msg err show';
        $msg.textContent = '✗ ' + (e.message || '실패');
      } finally {
        $btn.classList.remove('spinning');
        $btn.style.pointerEvents = '';
        setTimeout(() => { $msg.classList.remove('show'); }, 6000);
      }
    }

    async function loadFbPageReport() {
      const $main = document.getElementById('fb-page-report-main');
      if (!$main) return;
      const date = document.getElementById('fbPageReportDate')?.value;
      if (!date) { $main.innerHTML = '<div class="empty-state">날짜를 선택하세요.</div>'; return; }
      $main.innerHTML = skeletonHTML();
      try {
        const { reports } = await apiFetch(`/facebook/page/report?workspaceId=${WS}&date=${encodeURIComponent(date)}`);
        if (!reports || reports.length === 0) {
          $main.innerHTML = `<div class="empty-state">${date} 리포트가 없습니다.</div>`;
          return;
        }
        $main.innerHTML = reports.map((r, i) => (i > 0 ? '<div class="ch-divider"></div>' : '') + buildFbPageReportCard(r)).join('');
      } catch (err) {
        $main.innerHTML = `<div class="error-state">오류: ${err.message}</div>`;
      }
    }

    function buildFbPageReportCard(r) {
      const isNoPosts = r.crawlStatus === 'no_posts' || ((r.postCount || 0) === 0 && (!r.posts || r.posts.length === 0));
      const sourcePages = Array.isArray(r.sourcePages) ? r.sourcePages : [];
      const sourcePageNames = sourcePages.map((page) => page.pageName || page.pageId).filter(Boolean);
      const sourcePageLabel = sourcePageNames.length
        ? sourcePageNames.join(', ')
        : '게시물이 존재하지 않습니다';
      const crawlBadge = isNoPosts
        ? `<div class="badge">${SVG.doc} 게시물 없음</div>`
        : r.crawlStatus === 'partial'
        ? `<div class="badge alert">${SVG.warn} 부분 수집</div>`
        : r.crawlStatus === 'failed'
        ? `<div class="badge alert">${SVG.warn} 수집 오류</div>`
        : '';
      const issues = (r.aiIssues || []).map(issue => {
        const postUrl = issue.postIndex ? r.posts?.[issue.postIndex - 1]?.postUrl : null;
        const link = postUrl
          ? `<a href="${postUrl}" target="_blank" class="issue-msg-link" title="게시글 보기">↗</a>`
          : '';
        return `
        <div style="padding:10px 12px;background:#eff6ff;border-left:3px solid #2563eb;border-radius:0 8px 8px 0;margin-bottom:6px">
          <div style="font-size:13px;font-weight:600;color:#1d4ed8">${issue.title || ''}${link}</div>
          <div style="font-size:12px;color:#1e3a8a;margin-top:3px">${issue.description || ''}</div>
        </div>`;
      }).join('');
      if (isNoPosts) {
        return `
      <div class="ch-header anim d1">
        <div class="ch-platform-icon" style="color:#1877f2">${SVG_FB}</div>
        <div>
          <div class="ch-name">${escapeHtml(r.pageName || '')}</div>
          <div class="ch-row-meta" style="font-size:.75rem;color:var(--text-muted)">소스 페이지 ${sourcePages.length || 1}개 · ${escapeHtml(sourcePageLabel)}</div>
          <div class="ch-id">Facebook Page &middot; 게시글 0개 &middot; 댓글 0개 &middot; 대댓글 0개</div>
        </div>
        <div class="ch-badges">${crawlBadge}</div>
      </div>

      <div class="scard anim d2">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.doc}AI 동향 요약</div>
        <div style="font-size:.8125rem;color:var(--text);line-height:1.8">${sanitizeReportHtml(r.aiSummary || '게시물이 존재하지 않습니다')}</div>
      </div>

      <div class="scard anim d3">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.warn}주요 이슈</div>
        <div style="padding:10px 12px;background:#eff6ff;border-left:3px solid #93c5fd;border-radius:0 8px 8px 0;margin-bottom:6px">
          <div style="font-size:13px;font-weight:600;color:#1d4ed8">게시물이 존재하지 않습니다</div>
          <div style="font-size:12px;color:#1e3a8a;margin-top:3px">선택한 날짜에 이 페이지에서 새로 게시된 포스트가 없어 분석할 이슈가 없습니다.</div>
        </div>
      </div>

      <div class="token-info-strip anim d4">
        <span class="token-model">${escapeHtml(r.model || '')}</span>
        <span>입력 ${(r.promptTokens || 0).toLocaleString()} / 출력 ${(r.completionTokens || 0).toLocaleString()} / 합계 ${(r.totalTokens || 0).toLocaleString()} 토큰</span>
        <span>비용 $${Number(r.cost || 0).toFixed(4)}</span>
      </div>`;
      }
      return `
      <div class="ch-header anim d1">
        <div class="ch-platform-icon" style="color:#1877f2">${SVG_FB}</div>
        <div>
          <div class="ch-name">${escapeHtml(r.pageName || '')}</div>
          <div class="ch-row-meta" style="font-size:.75rem;color:var(--text-muted)">소스 페이지 ${sourcePages.length || 1}개 · ${escapeHtml(sourcePageLabel)}</div>
          <div class="ch-id">Facebook Page &middot; 게시글 ${r.postCount || 0}개 &middot; 댓글 ${(r.totalComments || 0).toLocaleString()} &middot; 대댓글 ${(r.totalReplies || 0).toLocaleString()}</div>
        </div>
        <div class="ch-badges">${crawlBadge}</div>
      </div>

      ${r.aiSummary ? `<div class="scard anim d2">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.doc}AI 동향 요약</div>
        <div style="font-size:.8125rem;color:var(--text);line-height:1.8">${sanitizeReportHtml(r.aiSummary)}</div>
      </div>` : ''}

      <div class="scard anim d3">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.warn}주요 이슈</div>
        ${issues || '<div style="color:var(--text-3);font-size:.875rem;line-height:1.8">오늘은 별도로 부각된 주요 이슈가 감지되지 않았습니다.</div>'}
      </div>

      ${(r.model || r.totalTokens) ? `
      <div class="token-info-strip anim d4">
        ${r.model ? `<span class="token-model">${escapeHtml(r.model)}</span>` : ''}
        ${r.totalTokens ? `<span>입력 ${(r.promptTokens || 0).toLocaleString()} / 출력 ${(r.completionTokens || 0).toLocaleString()} / 합계 ${(r.totalTokens || 0).toLocaleString()} 토큰</span>` : ''}
        ${r.cost != null ? `<span>비용 $${Number(r.cost).toFixed(4)}</span>` : ''}
      </div>` : ''}`;
    }

    // ── 페이지 관리 ───────────────────────────────────────────
    async function loadFbPages() {
      const $main = document.getElementById('fb-pages-main');
      if (!$main) return;

      $main.innerHTML = `
        <div class="ch-mgmt-grid">
          <div class="add-panel">
            <div class="panel-title">페이지 추가</div>
            <div class="panel-desc">관리자 User Access Token으로 운영 중인 Facebook 페이지 목록을 조회한 뒤 등록합니다.</div>
            <div class="info-banner" style="margin-bottom:1rem">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>토큰 관리/갱신까지 쓰려면 Meta 앱 ID, 앱 시크릿, User Access Token을 함께 저장합니다.</span>
            </div>
            <div class="field-group">
              <label class="field-label">Meta 앱 ID <span class="text-neg">*</span></label>
              <input class="field-input" id="fbPageAppIdInput" type="text" placeholder="1234567890" autocomplete="off">
            </div>
            <div class="field-group">
              <label class="field-label">Meta 앱 시크릿 <span class="text-neg">*</span></label>
              <input class="field-input" id="fbPageAppSecretInput" type="password" placeholder="앱 시크릿 코드" autocomplete="off">
            </div>
            <div class="field-group">
              <label class="field-label">관리자 User Access Token <span class="text-neg">*</span></label>
              <textarea class="field-input settings-textarea" id="fbPageTokenInput" rows="4" placeholder="EAAxxxx..."></textarea>
            </div>
            <button class="btn-add" id="fbPageDiscoverBtn" onclick="discoverFbPages()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              페이지 불러오기
            </button>
            <div id="fbPageCandidatePicker"></div>
            <div class="add-result" id="fbPageAddResult"></div>
          </div>
          <div class="list-panel">
            <div class="list-header">
              <span class="list-title">등록된 페이지</span>
              <span class="list-count" id="fbPageListCount">-</span>
            </div>
            <div id="fb-page-list"><div class="sk sk--sm"></div></div>
          </div>
        </div>`;

      try {
        const { pages } = await apiFetch(`/facebook/pages?workspaceId=${WS}`);
        _fbRegisteredPages = Array.isArray(pages) ? pages : [];
        document.getElementById('fbPageListCount').textContent = _fbRegisteredPages.length;
        const $list = document.getElementById('fb-page-list');
        $list.innerHTML = !_fbRegisteredPages.length
          ? '<div class="ch-empty"><div class="text-center-muted">등록된 페이지 없음</div></div>'
          : _fbRegisteredPages.map(fbPageRowHTML).join('');
      } catch (err) {
        _fbRegisteredPages = [];
        document.getElementById('fb-page-list').innerHTML =
          `<div class="state-wrap"><div class="state-title">불러오기 실패</div><div class="state-desc">${escapeHtml(err.message)}</div></div>`;
      }
    }

    function fbPageRowHTML(page) {
      const isActive = page.isActive !== false;
      const recipients = (page.deliveryConfig?.email?.recipients || []).join(', ');
      const isEmailEnabled = page.deliveryConfig?.email?.isEnabled ?? false;
      const panelId = `fb-page-settings-${page.docId}`;
      const reportGroupName = page.reportGroupName || page.pageName || page.pageId || '';
      const selectedModel = FB_ANALYSIS_MODELS.some(m => m.value === page.analysisModel)
        ? page.analysisModel
        : FB_ANALYSIS_MODELS[0].value;
      const normalizedValidatedAt = (() => {
        const v = page.lastValidatedAt;
        if (!v) return null;
        if (typeof v === 'string') return v;
        if (typeof v === 'object') {
          const secs = v._seconds ?? v.seconds;
          if (secs != null) return new Date(secs * 1000).toISOString();
          if (typeof v.toDate === 'function') return v.toDate().toISOString();
        }
        return null;
      })();
      const tokenStatus = page.tokenStatus || 'unknown';
      const tokenStatusMeta = tokenStatus === 'valid'
        ? { label: '토큰 유효', color: '#16a34a', bg: '#f0fdf4' }
        : tokenStatus === 'invalid'
        ? { label: '토큰 오류', color: '#dc2626', bg: '#fef2f2' }
        : tokenStatus === 'missing'
        ? { label: '토큰 누락', color: '#d97706', bg: '#fffbeb' }
        : { label: '상태 미확인', color: '#64748b', bg: '#f8fafc' };
      const expiry = tokenExpiryLabel(page.tokenExpiresAt);
      const validatedAt = normalizedValidatedAt
        ? new Date(normalizedValidatedAt).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })
        : '검증 이력 없음';

      return `
        <div class="ch-row ${isActive ? '' : 'inactive'}" id="fb-page-row-${page.docId}">
          <div class="ch-row-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;color:#1877F2">
              <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97h-1.513c-1.491 0-1.956.93-1.956 1.886v2.267h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/>
            </svg>
          </div>
          <div class="ch-row-info">
            <div class="ch-row-name">${escapeHtml(page.pageName || page.pageId)}</div>
            <div class="ch-row-meta">Facebook Page${page.pageCategory ? ` · ${escapeHtml(page.pageCategory)}` : ''}</div>
            <div class="ch-row-meta" style="font-size:.75rem;color:var(--text-muted)">pageId · ${escapeHtml(page.pageId || '-')}</div>
            <div class="ch-row-meta" style="font-size:.75rem;color:var(--text-muted)">리포트 그룹 · ${escapeHtml(reportGroupName)}</div>
            <div class="ig-debug-meta">
              <span style="display:inline-block;padding:.1rem .45rem;border-radius:4px;font-size:.7rem;font-weight:700;background:${tokenStatusMeta.bg};color:${tokenStatusMeta.color}">${tokenStatusMeta.label}</span>
              <span><strong>만료</strong> ${escapeHtml(expiry.text)}</span>
              <span><strong>검증</strong> ${escapeHtml(validatedAt)}</span>
            </div>
          </div>
          <div class="ch-row-status ${isActive ? 'active' : 'inactive'}">${isActive ? '활성' : '비활성'}</div>
          <div class="ch-row-actions">
            <div class="action-btn settings" data-docid="${escapeHtml(page.docId)}"
                 onclick="toggleFbPageSettings(this.dataset.docid)" title="설정">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </div>
            <div class="action-btn ${isActive ? 'toggle-on' : 'toggle-off'}"
                 data-docid="${escapeHtml(page.docId)}"
                 onclick="toggleFbPage(this.dataset.docid, ${isActive})"
                 title="${isActive ? '비활성화' : '활성화'}">
              ${isActive
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728L5.636 5.636"/></svg>`
                : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`}
            </div>
            <div class="action-btn del"
                 data-docid="${escapeHtml(page.docId)}" data-name="${escapeHtml(page.pageName || page.pageId)}"
                 onclick="deleteFbPage(this.dataset.docid, this.dataset.name)"
                 title="페이지 삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </div>
          </div>
        </div>
        <div class="ch-settings-panel" id="${panelId}">
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
              페이지 이름
            </div>
            <label class="settings-field-label" for="fbPageName-${page.docId}">표시 이름</label>
            <input class="field-input" id="fbPageName-${page.docId}" type="text" value="${escapeHtml(page.pageName || '')}" placeholder="예: Soul Strike_Global">
            <div style="font-size:.8rem;color:var(--text-muted);margin-top:.35rem">Facebook API에서 가져온 이름을 덮어씁니다. 저장 버튼을 눌러 적용하세요.</div>
            <button class="btn-save-settings" style="margin-top:.6rem" data-docid="${escapeHtml(page.docId)}"
                    onclick="saveFbPageSettings(this.dataset.docid)">저장</button>
            <div class="add-result" id="fbPageNameSaveResult-${page.docId}"></div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              토큰 관리
            </div>
            <div style="font-size:.8125rem;color:var(--text-muted);line-height:1.7;margin-bottom:.75rem">
              상태: <strong style="color:${tokenStatusMeta.color}">${tokenStatusMeta.label}</strong><br>
              만료: <strong>${escapeHtml(expiry.text)}</strong><br>
              마지막 검증: <strong>${escapeHtml(validatedAt)}</strong>
            </div>
            <div style="display:flex;gap:.5rem;flex-wrap:wrap">
              <button class="btn-save-settings" data-docid="${escapeHtml(page.docId)}"
                      onclick="checkFbPageToken(this.dataset.docid, this)">상태 확인</button>
              <button class="btn-save-settings" data-docid="${escapeHtml(page.docId)}"
                      onclick="refreshFbPageToken(this.dataset.docid, this)">토큰 갱신</button>
            </div>
            <div class="add-result" id="fbPageTokenResult-${page.docId}"></div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              이메일 리포트
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="fbPageEmailEnabled-${page.docId}" ${isEmailEnabled ? 'checked' : ''}>
              <span style="font-size:.875rem">이메일 발송 활성화</span>
            </label>
            <textarea class="settings-textarea" id="fbPageRecipients-${page.docId}"
              placeholder="수신자 이메일 (쉼표 구분)">${escapeHtml(recipients)}</textarea>
            <button class="btn-save-settings" data-docid="${escapeHtml(page.docId)}"
                    onclick="saveFbPageSettings(this.dataset.docid)">저장</button>
            <div class="add-result" id="fbPageSaveResult-${page.docId}"></div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18"/><path d="M3 12h18"/><path d="M3 17h18"/></svg>
              리포트 그룹
            </div>
            <div style="font-size:.8125rem;color:var(--text-muted);line-height:1.7;margin-bottom:.75rem">
              같은 그룹명을 가진 페이지들은 하나의 Facebook 페이지 리포트로 합쳐집니다.
            </div>
            <label class="settings-field-label" for="fbPageReportGroup-${page.docId}">리포트 그룹명</label>
            <input class="field-input" id="fbPageReportGroup-${page.docId}" type="text" value="${escapeHtml(reportGroupName)}" placeholder="예: Soul Strike Global">
          </div>
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M2 12a10 10 0 1 0 20 0"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83"/></svg>
              지역(자식) 페이지
            </div>
            <div style="font-size:.8125rem;color:var(--text-muted);line-height:1.7;margin-bottom:.75rem">
              Global Page 하위에 연결된 지역별 자식 페이지를 자동으로 탐색하고 같은 리포트 그룹으로 일괄 등록합니다.
            </div>
            <button class="btn-save-settings"
                    data-docid="${escapeHtml(page.docId)}"
                    data-pagename="${escapeHtml(page.pageName || page.pageId)}"
                    data-groupname="${escapeHtml(reportGroupName)}"
                    onclick="discoverFbChildPages(this.dataset.docid, this.dataset.pagename, this.dataset.groupname, this)">
              지역 페이지 탐색
            </button>
            <div class="add-result" id="fbChildDiscoverResult-${page.docId}" style="display:none"></div>
            <div id="fbChildCandidatePicker-${page.docId}"></div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
              AI 분석 지시문
            </div>
            <label class="settings-field-label" for="fbPageAnalysisModel-${page.docId}">AI 모델</label>
            <select class="settings-select" id="fbPageAnalysisModel-${page.docId}">
              ${FB_ANALYSIS_MODELS.map(m => `
                <option value="${escapeHtml(m.value)}" ${selectedModel === m.value ? 'selected' : ''}>
                  ${escapeHtml(m.label)}
                </option>
              `).join('')}
            </select>
            <textarea class="settings-textarea" id="fbPageAnalysisPrompt-${page.docId}"
              rows="3" placeholder="예: 반복 문의와 부정 피드백을 우선적으로 요약해줘.">${escapeHtml(page.analysisPrompt || '')}</textarea>
            <button class="btn-save-settings" data-docid="${escapeHtml(page.docId)}"
                    onclick="saveFbPageSettings(this.dataset.docid)">저장</button>
            ${page.lastTokenError ? `<div class="add-result" style="display:block;color:var(--neg)">${escapeHtml(page.lastTokenError)}</div>` : ''}
          </div>
        </div>`;
    }

    function toggleFbPageSettings(docId) {
      const panel = document.getElementById(`fb-page-settings-${docId}`);
      if (panel) panel.classList.toggle('open');
    }

    function renderFbPageCandidatePicker(pages) {
      return `
        <div class="info-banner ig-picker-banner" style="margin-top:1rem;display:block">
          <div class="ig-picker-title">연결된 Facebook 페이지 선택</div>
          <div class="ig-picker-desc">이 토큰으로 조회 가능한 페이지 목록입니다. 저장하면 해당 페이지의 Page Access Token이 함께 등록됩니다.</div>
          <div class="ig-picker-list">
            ${pages.map((page) => `
              <button type="button"
                class="btn-save-settings ig-picker-btn"
                onclick="confirmFbPageSelection('${escapeHtml(page.pageId)}')">
                <span class="ig-picker-main">
                  <span class="ig-picker-account">${escapeHtml(page.pageName || page.pageId)}</span>
                  <span class="ig-picker-page">${escapeHtml(page.pageCategory || 'Facebook Page')}</span>
                </span>
                <span class="ig-picker-debug">
                  <span><strong>pageId</strong> ${escapeHtml(page.pageId || '-')}</span>
                </span>
              </button>`).join('')}
          </div>
        </div>`;
    }

    async function discoverFbChildPages(parentDocId, parentPageName, inheritedReportGroupName, btn) {
      const $result = document.getElementById(`fbChildDiscoverResult-${parentDocId}`);
      const $picker = document.getElementById(`fbChildCandidatePicker-${parentDocId}`);
      if (!$result || !$picker) return;

      $result.style.display = 'none';
      $result.textContent = '';
      $picker.innerHTML = '';
      _fbChildPendingSelection = null;

      const origLabel = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin .75s linear infinite;width:14px;height:14px"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 탐색 중...`;

      try {
        const res = await apiFetch('/facebook/pages/discover-children', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, parentDocId }),
        });

        const children = Array.isArray(res.children) ? res.children : [];
        if (!children.length) {
          $picker.innerHTML = renderFbChildManualInput(inheritedReportGroupName, parentDocId);
          return;
        }

        _fbChildPendingSelection = { parentDocId, parentPageName, inheritedReportGroupName, children };
        $picker.innerHTML = renderFbChildCandidatePicker(children, inheritedReportGroupName, parentDocId);
      } catch (err) {
        $result.className = 'add-result err';
        $result.style.display = 'block';
        $result.textContent = err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = origLabel;
      }
    }

    function renderFbChildManualInput(defaultReportGroupName, parentDocId) {
      return `
        <div class="info-banner ig-picker-banner" style="margin-top:1rem;display:block">
          <div class="ig-picker-title">자동 탐색 불가 — pageId 직접 입력</div>
          <div class="ig-picker-desc">Facebook Global Brand Pages로 연결되지 않은 경우 자동 탐색이 되지 않습니다. 지역 페이지 ID를 직접 입력하면 부모 페이지 토큰으로 정보를 조회해 등록합니다.</div>
          <div style="margin-top:.75rem">
            <label class="settings-field-label">지역 페이지 ID (줄 바꿈 구분)</label>
            <textarea class="settings-textarea" id="fbChildManualIds-${escapeHtml(parentDocId)}"
              rows="3" placeholder="예: 123456789&#10;987654321"></textarea>
          </div>
          <div style="margin-top:.5rem">
            <label class="settings-field-label">User Access Token <span style="font-weight:400;color:var(--text-muted)">(지역 페이지 관리자 토큰 — 저장된 토큰으로 조회 불가 시 입력)</span></label>
            <textarea class="settings-textarea" id="fbChildManualToken-${escapeHtml(parentDocId)}"
              rows="2" placeholder="EAAxxxx... (선택사항)"></textarea>
          </div>
          <div style="margin-top:.5rem">
            <label class="settings-field-label" for="fbChildManualGroup-${escapeHtml(parentDocId)}">리포트 그룹명</label>
            <input class="field-input" id="fbChildManualGroup-${escapeHtml(parentDocId)}"
              type="text" value="${escapeHtml(defaultReportGroupName)}" placeholder="예: Soul Strike Global">
          </div>
          <button class="btn-save-settings" style="margin-top:.5rem"
            data-docid="${escapeHtml(parentDocId)}"
            onclick="lookupFbChildPagesByIds(this.dataset.docid, this)">
            페이지 조회 및 등록
          </button>
          <div class="add-result" id="fbChildManualResult-${escapeHtml(parentDocId)}" style="display:none"></div>
        </div>`;
    }

    async function lookupFbChildPagesByIds(parentDocId, btn) {
      const $textarea = document.getElementById(`fbChildManualIds-${parentDocId}`);
      const $tokenInput = document.getElementById(`fbChildManualToken-${parentDocId}`);
      const $groupInput = document.getElementById(`fbChildManualGroup-${parentDocId}`);
      const $result = document.getElementById(`fbChildManualResult-${parentDocId}`);
      if (!$textarea || !$groupInput || !$result) return;

      const pageIds = $textarea.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!pageIds.length) {
        $result.className = 'add-result err';
        $result.style.display = 'block';
        $result.textContent = '페이지 ID를 하나 이상 입력해 주세요.';
        return;
      }
      const reportGroupName = $groupInput.value.trim();
      if (!reportGroupName) {
        $result.className = 'add-result err';
        $result.style.display = 'block';
        $result.textContent = '리포트 그룹명을 입력해 주세요.';
        return;
      }

      const origLabel = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin .75s linear infinite;width:14px;height:14px"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 조회 중...`;
      $result.style.display = 'none';

      try {
        const lookupRes = await apiFetch('/facebook/pages/lookup-by-ids', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: WS,
            parentDocId,
            pageIds,
            userAccessToken: $tokenInput ? $tokenInput.value.trim() : '',
          }),
        });

        const children = Array.isArray(lookupRes.children) ? lookupRes.children : [];
        if (!children.length) {
          $result.className = 'add-result err';
          $result.style.display = 'block';
          $result.textContent = '입력한 pageId로 페이지 정보를 가져올 수 없습니다. pageId를 확인해 주세요.';
          return;
        }

        const pages = children.map((c) => ({
          pageId: c.pageId,
          pageName: c.pageName,
          pageCategory: c.pageCategory,
          pictureUrl: c.pictureUrl,
          pageAccessToken: c.pageAccessToken || '',
        }));

        const registerRes = await apiFetch('/facebook/pages/bulk-register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, reportGroupName, pages }),
        });

        let msg = `등록 완료: ${registerRes.registeredCount}개 등록`;
        if (registerRes.failedCount > 0) {
          msg += `, ${registerRes.failedCount}개 실패`;
          const failList = (registerRes.failed || []).map((f) => `• ${escapeHtml(f.pageName || f.pageId)}: ${escapeHtml(f.reason)}`).join('\n');
          msg += `\n${failList}`;
        }

        $result.className = 'add-result ok';
        $result.style.display = 'block';
        $result.style.whiteSpace = 'pre-line';
        $result.textContent = msg;
        await loadFbPages();
      } catch (err) {
        $result.className = 'add-result err';
        $result.style.display = 'block';
        $result.textContent = err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = origLabel;
      }
    }

    function renderFbChildCandidatePicker(children, defaultReportGroupName, parentDocId) {
      return `
        <div class="info-banner ig-picker-banner" style="margin-top:1rem;display:block">
          <div class="ig-picker-title">발견된 지역 페이지 (${children.length}개)</div>
          <div class="ig-picker-desc">등록할 페이지를 선택하고 리포트 그룹명을 확인한 후 일괄 등록하세요.</div>
          <div class="ig-picker-list" style="display:flex;flex-direction:column;gap:.4rem">
            ${children.map((c) => `
              <label class="ig-picker-btn" style="display:flex;align-items:center;gap:.6rem;cursor:pointer">
                <input type="checkbox" value="${escapeHtml(c.pageId)}" checked
                  style="width:15px;height:15px;flex-shrink:0">
                <span class="ig-picker-main">
                  <span class="ig-picker-account">${escapeHtml(c.pageName || c.pageId)}</span>
                  <span class="ig-picker-page">${escapeHtml(c.pageCategory || 'Facebook Page')}</span>
                </span>
                <span class="ig-picker-debug">
                  <span><strong>pageId</strong> ${escapeHtml(c.pageId)}</span>
                  ${!c.pageAccessToken ? `<span style="color:var(--neg)">⚠ 토큰 없음 — 등록 후 수동 입력 필요</span>` : ''}
                </span>
              </label>`).join('')}
          </div>
          <div style="margin-top:.75rem">
            <label class="settings-field-label" for="fbChildReportGroup-${escapeHtml(parentDocId)}">리포트 그룹명</label>
            <input class="field-input" id="fbChildReportGroup-${escapeHtml(parentDocId)}"
              type="text" value="${escapeHtml(defaultReportGroupName)}" placeholder="예: Soul Strike Global">
          </div>
          <button class="btn-save-settings" style="margin-top:.5rem"
            data-docid="${escapeHtml(parentDocId)}"
            onclick="confirmFbChildBulkRegister(this.dataset.docid, this)">
            일괄 등록
          </button>
          <div class="add-result" id="fbChildRegisterResult-${escapeHtml(parentDocId)}" style="display:none"></div>
        </div>`;
    }

    async function confirmFbChildBulkRegister(parentDocId, btn) {
      const pending = _fbChildPendingSelection;
      const $result = document.getElementById(`fbChildRegisterResult-${parentDocId}`);
      if (!pending || !$result) return;
      if (pending.parentDocId !== parentDocId) {
        $result.className = 'add-result err';
        $result.style.display = 'block';
        $result.textContent = '탐색 결과가 만료되었습니다. 다시 탐색해 주세요.';
        return;
      }

      const $picker = document.getElementById(`fbChildCandidatePicker-${parentDocId}`);
      const $groupInput = document.getElementById(`fbChildReportGroup-${parentDocId}`);
      const reportGroupName = $groupInput ? $groupInput.value.trim() : '';
      if (!reportGroupName) {
        $result.className = 'add-result err';
        $result.style.display = 'block';
        $result.textContent = '리포트 그룹명을 입력해 주세요.';
        return;
      }

      const checkboxes = $picker ? $picker.querySelectorAll('input[type="checkbox"]:checked') : [];
      const selectedIds = new Set([...checkboxes].map((el) => el.value));
      if (!selectedIds.size) {
        $result.className = 'add-result err';
        $result.style.display = 'block';
        $result.textContent = '등록할 페이지를 하나 이상 선택해 주세요.';
        return;
      }

      const pages = pending.children
        .filter((c) => selectedIds.has(c.pageId))
        .map((c) => ({
          pageId: c.pageId,
          pageName: c.pageName,
          pageCategory: c.pageCategory,
          pictureUrl: c.pictureUrl,
          pageAccessToken: c.pageAccessToken || '',
        }));

      const origLabel = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin .75s linear infinite;width:14px;height:14px"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 등록 중...`;

      try {
        const res = await apiFetch('/facebook/pages/bulk-register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, reportGroupName, pages }),
        });

        let msg = `등록 완료: ${res.registeredCount}개 등록`;
        if (res.failedCount > 0) {
          msg += `, ${res.failedCount}개 실패`;
          const failList = (res.failed || []).map((f) => `• ${escapeHtml(f.pageName || f.pageId)}: ${escapeHtml(f.reason)}`).join('\n');
          msg += `\n${failList}`;
        }

        $result.className = 'add-result ok';
        $result.style.display = 'block';
        $result.style.whiteSpace = 'pre-line';
        $result.textContent = msg;

        if ($picker) $picker.innerHTML = '';
        _fbChildPendingSelection = null;
        await loadFbPages();
      } catch (err) {
        $result.className = 'add-result err';
        $result.style.display = 'block';
        $result.textContent = err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = origLabel;
      }
    }

    async function discoverFbPages() {
      const appId = document.getElementById('fbPageAppIdInput')?.value.trim();
      const appSecret = document.getElementById('fbPageAppSecretInput')?.value.trim();
      const token = document.getElementById('fbPageTokenInput')?.value.trim();
      const $picker = document.getElementById('fbPageCandidatePicker');
      const $result = document.getElementById('fbPageAddResult');
      const $btn = document.getElementById('fbPageDiscoverBtn');
      if (!appId) { $result.className = 'add-result err'; $result.textContent = '앱 ID를 입력해 주세요.'; return; }
      if (!appSecret) { $result.className = 'add-result err'; $result.textContent = '앱 시크릿을 입력해 주세요.'; return; }
      if (!token) { $result.className = 'add-result err'; $result.textContent = '액세스 토큰을 입력해 주세요.'; return; }

      _fbPagePendingSelection = null;
      if ($picker) $picker.innerHTML = '';
      $btn.disabled = true;
      $btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin .75s linear infinite"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 조회 중...`;
      $result.className = 'add-result';
      $result.textContent = '';

      try {
        const res = await apiFetch('/facebook/pages/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, accessToken: token }),
        });
        const pages = Array.isArray(res.pages) ? res.pages : [];
        if (!pages.length) {
          $result.className = 'add-result err';
          $result.textContent = '이 토큰으로 조회 가능한 페이지가 없습니다.';
          return;
        }
        _fbPagePendingSelection = { token, appId, appSecret, pages };
        if ($picker) $picker.innerHTML = renderFbPageCandidatePicker(pages);
        $result.className = 'add-result';
        $result.textContent = '등록할 Facebook 페이지를 선택해 주세요.';
      } catch (err) {
        $result.className = 'add-result err';
        $result.textContent = err.message;
      } finally {
        $btn.disabled = false;
        $btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> 페이지 불러오기`;
      }
    }

    async function confirmFbPageSelection(pageId) {
      const pending = _fbPagePendingSelection;
      const $result = document.getElementById('fbPageAddResult');
      const $picker = document.getElementById('fbPageCandidatePicker');
      const $btn = document.getElementById('fbPageDiscoverBtn');
      if (!pending) return;

      const page = pending.pages.find((candidate) => String(candidate.pageId) === String(pageId));
      if (!page) {
        $result.className = 'add-result err';
        $result.textContent = '선택한 페이지 정보를 찾을 수 없습니다.';
        return;
      }

      $btn.disabled = true;
      $btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin .75s linear infinite"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 저장 중...`;

      try {
        const res = await apiFetch('/facebook/pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: WS,
            pageId: page.pageId,
            pageName: page.pageName,
            pageAccessToken: page.pageAccessToken,
            pageCategory: page.pageCategory,
            pictureUrl: page.pictureUrl,
            sourceUserAccessToken: pending.token,
            appId: pending.appId,
            appSecret: pending.appSecret,
          }),
        });
        _fbPagePendingSelection = null;
        if ($picker) $picker.innerHTML = '';
        document.getElementById('fbPageAppIdInput').value = '';
        document.getElementById('fbPageAppSecretInput').value = '';
        document.getElementById('fbPageTokenInput').value = '';
        $result.className = 'add-result ok';
        $result.textContent = `${res.updated ? '토큰 갱신 완료:' : '페이지 등록 완료:'} ${res.pageName || page.pageName || page.pageId}`;
        await loadFbPages();
      } catch (err) {
        $result.className = 'add-result err';
        $result.textContent = err.message;
      } finally {
        $btn.disabled = false;
        $btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> 페이지 불러오기`;
      }
    }

    async function toggleFbPage(docId, currentActive) {
      try {
        await apiFetch(`/facebook/pages?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !currentActive }),
        });
        await loadFbPages();
      } catch (err) { alert('상태 변경 실패: ' + err.message); }
    }

    async function saveFbPageSettings(docId) {
      const isEnabled = document.getElementById(`fbPageEmailEnabled-${docId}`)?.checked ?? false;
      const recipients = (document.getElementById(`fbPageRecipients-${docId}`)?.value || '')
        .split(/[,\n]/).map(e => e.trim()).filter(Boolean);
      const pageName = document.getElementById(`fbPageName-${docId}`)?.value?.trim() || '';
      const reportGroupName = document.getElementById(`fbPageReportGroup-${docId}`)?.value?.trim() || '';
      const analysisPrompt = document.getElementById(`fbPageAnalysisPrompt-${docId}`)?.value || '';
      const analysisModel = document.getElementById(`fbPageAnalysisModel-${docId}`)?.value || FB_ANALYSIS_MODELS[0].value;
      const $result = document.getElementById(`fbPageSaveResult-${docId}`);
      try {
        await apiFetch(`/facebook/pages/settings?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deliveryConfig: { email: { isEnabled, recipients } },
            pageName,
            reportGroupName,
            analysisPrompt,
            analysisModel,
          }),
        });
        if ($result) {
          $result.textContent = '✓ 저장됨';
          $result.style.color = 'var(--pos)';
          setTimeout(() => { if ($result) $result.textContent = ''; }, 2000);
        }
        await loadFbPages();
      } catch (err) {
        if ($result) {
          $result.textContent = '저장 실패: ' + err.message;
          $result.style.color = 'var(--neg)';
        }
      }
    }

    async function deleteFbPage(docId, pageName) {
      const ok = await confirmDialog(`페이지 "${pageName}"를 삭제하시겠습니까?\n관련 리포트도 함께 삭제됩니다.`);
      if (!ok) return;
      try {
        await apiFetch(`/facebook/pages?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, { method: 'DELETE' });
        await loadFbPages();
      } catch (err) { alert('삭제 실패: ' + err.message); }
    }

    async function checkFbPageToken(docId, btn) {
      const $result = document.getElementById(`fbPageTokenResult-${docId}`);
      if (!$result) return;
      btn.disabled = true;
      $result.className = 'add-result';
      $result.style.color = '#94a3b8';
      $result.textContent = '확인 중...';
      try {
        const res = await apiFetch(`/facebook/pages/token/check?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'POST',
        });
        if (res.valid) {
          const expiryText = res.tokenExpiresAt
            ? ` · 만료 ${new Date(res.tokenExpiresAt).toLocaleDateString('ko-KR')}`
            : '';
          $result.style.color = 'var(--pos)';
          $result.textContent = `✓ 유효${expiryText}`;
        } else {
          $result.style.color = 'var(--neg)';
          $result.textContent = `✗ ${res.error || '유효하지 않음'}`;
        }
        await loadFbPages();
      } catch (err) {
        $result.style.color = 'var(--neg)';
        $result.textContent = '상태 확인 실패: ' + err.message;
      } finally {
        btn.disabled = false;
      }
    }

    async function refreshFbPageToken(docId, btn) {
      const $result = document.getElementById(`fbPageTokenResult-${docId}`);
      if (!$result) return;
      btn.disabled = true;
      $result.className = 'add-result';
      $result.style.color = '#94a3b8';
      $result.textContent = '갱신 중...';
      try {
        const res = await apiFetch(`/facebook/pages/token/refresh?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'POST',
        });
        const expiryText = res.tokenExpiresAt
          ? `새 만료일: ${new Date(res.tokenExpiresAt).toLocaleDateString('ko-KR')}`
          : '만료일 정보 없음';
        $result.style.color = 'var(--pos)';
        $result.textContent = `✓ 토큰 갱신 완료 · ${expiryText}`;
        await loadFbPages();
      } catch (err) {
        $result.style.color = 'var(--neg)';
        $result.textContent = '토큰 갱신 실패: ' + err.message;
      } finally {
        btn.disabled = false;
      }
    }

    // ── 세션 관리 ─────────────────────────────────────────────
    async function loadFbSession() {
      const $main = document.getElementById('fb-session-main');
      if (!$main) return;
      try {
        const status = await apiFetch(`/facebook/session/status?workspaceId=${WS}`);

        const isValid   = status.isValid;
        const exists    = status.exists;
        const badgeColor  = isValid ? '#16a34a' : '#dc2626';
        const badgeBg     = isValid ? '#f0fdf4' : '#fef2f2';
        const badgeBorder = isValid ? '#bbf7d0' : '#fecaca';
        const badgeText   = !exists ? '세션 없음' : isValid ? '세션 유효' : '세션 만료됨';
        const badgeDesc   = !exists
          ? '등록된 세션이 없습니다. 아래에서 요청 헤더를 등록하세요.'
          : isValid
          ? '로그인 상태가 유효합니다. 파이프라인이 정상 실행됩니다.'
          : '세션이 만료되었습니다. 요청 헤더를 다시 등록해주세요.';

        $main.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start">

            <!-- 왼쪽: 요청 세션 등록 폼 -->
            <div class="panel-card">
              <div class="panel-title">요청 세션 등록</div>

              <!-- 안내 박스 -->
              <div style="display:flex;gap:10px;padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;margin-bottom:16px">
                <svg style="flex-shrink:0;margin-top:1px" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <div style="font-size:12.5px;color:#1e40af;line-height:1.6">
                  브라우저에서 facebook.com 로그인 후<br>
                  <strong>DevTools (F12) → Application → Cookies → .facebook.com</strong><br>
                  쿠키 전체를 JSON 배열로 복사해 붙여넣으세요.
                </div>
              </div>

              <!-- textarea -->
              <div style="margin-bottom:14px">
                <label style="display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:6px">Cookie JSON 배열</label>
                <textarea
                  id="fbCookieInput"
                  rows="10"
                  style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;resize:vertical;outline:none;color:#1e293b;background:#f8fafc;line-height:1.5"
                  placeholder='[{"name":"c_user","value":"...","domain":".facebook.com",...}]'
                ></textarea>
              </div>

              <!-- 버튼 -->
              <div style="display:flex;gap:8px">
                <button class="btn-primary" style="flex:1" onclick="saveFbCookies()">
                  세션 저장
                </button>
                ${exists ? `
                <button class="btn-secondary" onclick="deleteFbSession()" style="padding:0 16px">
                  세션 삭제
                </button>` : ''}
              </div>
            </div>

            <!-- 오른쪽: 세션 상태 -->
            <div style="display:flex;flex-direction:column;gap:14px">

              <!-- 상태 뱃지 카드 -->
              <div class="panel-card" style="padding:20px">
                <div class="panel-title" style="margin-bottom:14px">세션 상태</div>
                <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:${badgeBg};border:1px solid ${badgeBorder};border-radius:10px">
                  <span style="width:10px;height:10px;border-radius:50%;background:${badgeColor};flex-shrink:0;
                    ${isValid ? 'box-shadow:0 0 0 3px rgba(22,163,74,.2)' : ''}"></span>
                  <div>
                    <div style="font-size:13px;font-weight:700;color:#1e293b">${badgeText}</div>
                    <div style="font-size:11.5px;color:#64748b;margin-top:2px">${badgeDesc}</div>
                  </div>
                </div>
              </div>

              ${exists ? `
              <button id="fbVerifyBtn" class="btn-secondary" style="width:100%;margin-top:4px" onclick="verifyFbSession()">
                세션 재검증
              </button>` : ''}

              <!-- 상세 정보 카드 (세션이 있을 때만) -->
              ${exists ? `
              <div class="panel-card" style="padding:20px">
                <div class="panel-title" style="margin-bottom:12px">저장 정보</div>
                <div style="display:flex;flex-direction:column;gap:10px">
                  <div class="row-between">
                    <span style="color:#64748b">쿠키 수</span>
                    <span style="font-weight:600;color:#1e293b">${status.cookieCount || 0}개</span>
                  </div>
                  ${status.savedAt ? `
                  <div class="row-between">
                    <span style="color:#64748b">저장일시</span>
                    <span style="font-weight:500;color:#1e293b">${new Date(status.savedAt).toLocaleString('ko-KR', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
                  </div>` : ''}
                  ${status.lastValidatedAt ? `
                  <div class="row-between">
                    <span style="color:#64748b">마지막 확인</span>
                    <span style="font-weight:500;color:#1e293b">${new Date(status.lastValidatedAt).toLocaleString('ko-KR', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
                  </div>` : ''}
                </div>
              </div>` : ''}

            </div>
          </div>`;
        checkFbSessionAlert();
      } catch (err) {
        $main.innerHTML = `<div class="error-state">오류: ${err.message}</div>`;
      }
    }

    async function saveFbCookies() {
      const raw = document.getElementById('fbCookieInput')?.value.trim();
      if (!raw) { alert('쿠키 JSON을 입력하세요.'); return; }
      let cookies;
      try { cookies = JSON.parse(raw); } catch { alert('유효한 JSON 형식이 아닙니다.'); return; }
      if (!Array.isArray(cookies)) { alert('쿠키는 배열([ ... ]) 형식이어야 합니다.'); return; }
      try {
        const res = await apiFetch('/facebook/session', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, cookies }),
        });
        alert(`세션 저장 완료 (쿠키 ${res.cookieCount}개)`);
        await loadFbSession();
      } catch (err) { alert('저장 실패: ' + err.message); }
    }

    async function deleteFbSession() {
      const ok = await confirmDialog('저장된 Facebook 세션(쿠키)을 삭제하시겠습니까?');
      if (!ok) return;
      try {
        await apiFetch(`/facebook/session?workspaceId=${WS}`, { method: 'DELETE' });
        await loadFbSession();
      } catch (err) { alert('삭제 실패: ' + err.message); }
    }

    async function verifyFbSession() {
      const btn = document.getElementById('fbVerifyBtn');
      if (btn) { btn.disabled = true; btn.textContent = '검증 중...'; }
      try {
        const res = await apiFetch('/facebook/session/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS }),
        });
        await loadFbSession();
        alert(res.isValid ? '세션 유효 ✓ 로그인 상태가 확인되었습니다.' : '세션 만료 — 쿠키를 다시 등록해주세요.');
      } catch (err) {
        alert('재검증 실패: ' + err.message);
        if (btn) { btn.disabled = false; btn.textContent = '세션 재검증'; }
      }
    }

    // ════════════════════════════════════════════════════════
    //  네이버 라운지
    // ════════════════════════════════════════════════════════

    const SVG_NL = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.273 12.845 7.376 0H0v24h7.727V11.155L16.624 24H24V0h-7.727z"/></svg>`;
    const SVG_DC = `<img src="/dc-icon.png" style="width:22px;height:22px;border-radius:5px;object-fit:cover" alt="DCInside">`;

    // ── 가용 날짜 갱신 ──────────────────────────────────────
    async function refreshNlAvailableDates() {
      try {
        const { dates } = await apiFetch(`/naver/available-dates?workspaceId=${WS}`);
        if (!dates.length) return;
        if (_fpNlDatePicker) {
          _fpNlDatePicker.set('enable', dates);
          if (!_fpNlDatePicker.selectedDates.length) _fpNlDatePicker.setDate(dates[0], false);
        } else {
          document.getElementById('nlReportDate').value = dates[0] || '';
        }
      } catch (e) { /* silent */ }
    }

    // ── 수동 트리거 ─────────────────────────────────────────
    async function triggerNlReport() {
      const $btn = document.getElementById('nlTriggerBtn');
      const $msg = document.getElementById('nlTriggerMsg');
      $btn.classList.add('spinning');
      $msg.textContent = '수집 중…';
      try {
        const date = document.getElementById('nlReportDate')?.value || '';
        await apiFetch('/naver/pipeline/trigger', {
          method: 'POST',
          body: JSON.stringify({ workspaceId: WS, date: date || undefined }),
        });
        $msg.textContent = '수집 완료';
        await refreshNlAvailableDates();
        await loadNlReport();
      } catch (err) {
        $msg.textContent = '오류: ' + err.message;
      } finally {
        $btn.classList.remove('spinning');
        setTimeout(() => { $msg.textContent = ''; }, 5000);
      }
    }

    // ── 리포트 조회 ─────────────────────────────────────────
    async function loadNlReport() {
      const date = document.getElementById('nlReportDate')?.value;
      const $main = document.getElementById('nl-report-main');
      if (!date || !$main) return;
      $main.innerHTML = skeletonHTML();
      try {
        const { reports } = await apiFetch(`/naver/report?workspaceId=${WS}&date=${date}`);
        if (!reports || !reports.length) {
          $main.innerHTML = '<div class="empty-state">해당 날짜의 리포트가 없습니다.</div>';
          return;
        }
        $main.innerHTML = reports.map(buildNlReportCard).join('');
        requestAnimationFrame(() => requestAnimationFrame(() => {
          $main.querySelectorAll('.sent-seg[data-v]').forEach(el => { el.style.width = el.dataset.v + '%'; });
        }));
      } catch (err) {
        $main.innerHTML = `<div class="error-state">오류: ${err.message}</div>`;
      }
    }

    function buildNlReportCard(r) {
      const sentiment = r.aiSentiment || {};
      const pos = sentiment.positive ?? 0;
      const neu = sentiment.neutral ?? 0;
      const neg = sentiment.negative ?? 0;
      const crawlBadge = r.crawlStatus === 'partial'
        ? `<span class="badge alert">부분 수집</span>`
        : r.crawlStatus === 'session_expired'
        ? `<span class="badge alert">세션 만료</span>`
        : '';

      const issues = (r.aiIssues || []).map(issue => {
        const postUrl = issue.postIndex ? (r.posts || [])[issue.postIndex - 1]?.postUrl || null : null;
        const linkBtn = postUrl
          ? `<a href="${postUrl}" target="_blank" rel="noopener" class="issue-msg-link">↗</a>`
          : '';
        const sev = severity(issue.count || 1);
        return `<div class="issue-card ${sev.cls}">
          <div class="issue-sev-bar"></div>
          <div class="issue-count-badge">${issue.count || 1}</div>
          <div class="issue-body">
            <div class="issue-title">${escapeHtml(issue.title || '')}${issue.postIndex ? `<span style="color:var(--accent);font-size:.75rem;margin-left:.375rem">게시글 ${issue.postIndex}</span>` : ''}${linkBtn}</div>
            <div class="issue-desc">${escapeHtml(issue.description || '')}</div>
          </div>
          <div class="issue-sev-label">${sev.label}</div>
        </div>`;
      }).join('');

      const tokenStrip = (r.model || r.totalTokens) ? `
        <div class="token-info-strip">
          ${r.model ? `<span class="token-model">${escapeHtml(r.model)}</span>` : ''}
          ${r.totalTokens ? `<span>입력 ${(r.promptTokens||0).toLocaleString()} / 출력 ${(r.completionTokens||0).toLocaleString()} / 합계 ${(r.totalTokens||0).toLocaleString()} 토큰</span>` : ''}
          ${r.cost != null ? `<span>비용 $${Number(r.cost).toFixed(4)}</span>` : ''}
        </div>` : '';

      return `
      <div class="ch-card anim d1">
        <div class="ch-header anim d1">
          <div class="ch-platform-icon" style="color:#03C75A">${SVG_NL}</div>
          <div>
            <div class="ch-name">${escapeHtml(r.loungeName || '')}</div>
            <div class="ch-meta">
              ${r.postCount != null ? `게시글 ${r.postCount}개` : ''}
              ${r.totalComments != null ? ` &nbsp;·&nbsp; 댓글 ${r.totalComments.toLocaleString()}개` : ''}
              ${r.aiIssues?.length != null ? ` &nbsp;·&nbsp; 이슈 ${r.aiIssues.length}건` : ''}
              ${crawlBadge}
            </div>
          </div>
        </div>

        <div class="scard anim d2">
          <div class="slabel"><div class="slabel-dot"></div>${SVG.doc}라운지 동향 요약</div>
          <p class="summary-body">${formatSummary(r.aiSummary)}</p>
        </div>

        <div class="scard anim d3">
          <div class="slabel"><div class="slabel-dot"></div>${SVG.bar}감정 분석</div>
          <div class="sent-wrap">
            <div class="sent-spectrum">
              <div class="sent-seg pos" data-v="${pos}" style="width:0%"></div>
              <div class="sent-seg neu" data-v="${neu}" style="width:0%"></div>
              <div class="sent-seg neg" data-v="${neg}" style="width:0%"></div>
            </div>
            <div class="sent-tiles">
              <div class="sent-tile"><div class="sent-tile-val pos">${pos}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">긍정</div></div>
              <div class="sent-tile"><div class="sent-tile-val neu">${neu}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">중립</div></div>
              <div class="sent-tile"><div class="sent-tile-val neg">${neg}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">부정</div></div>
            </div>
          </div>
        </div>

        <div class="scard anim d4" style="margin-top:1rem">
          <div class="slabel"><div class="slabel-dot"></div>${SVG.warn}주요 이슈 <span class="slabel-count">${r.aiIssues?.length || 0}건</span></div>
          ${issues || `<div style="color:var(--text-3);font-size:.875rem;line-height:1.8">오늘은 별도로 부각된 주요 이슈가 감지되지 않았습니다.</div>`}
        </div>

        ${tokenStrip}
      </div>`;
    }

    // ── 라운지 관리 ─────────────────────────────────────────
    async function loadNlLounges() {
      const $main = document.getElementById('nl-lounges-main');
      if (!$main) return;

      $main.innerHTML = `
        <div class="ch-mgmt-grid">
          <div class="add-panel">
            <div class="panel-title">라운지 추가</div>
            <div class="panel-desc">모니터링할 네이버 게임 라운지 URL을 등록합니다.</div>
            <div class="field-group">
              <label class="field-label">라운지 이름 <span style="color:var(--text-muted);font-size:.75rem">(선택)</span></label>
              <input class="field-input" id="nlNewLoungeName" type="text" placeholder="예: 소울스트라이크 라운지" autocomplete="off">
            </div>
            <div class="field-group">
              <label class="field-label">라운지 URL <span class="text-neg">*</span></label>
              <input class="field-input" id="nlNewLoungeUrl" type="text" placeholder="https://game.naver.com/lounge/{id}/board" autocomplete="off">
            </div>
            <button class="btn-add" onclick="addNlLounge()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              라운지 추가
            </button>
            <div class="add-result" id="nlAddResult"></div>
          </div>
          <div class="list-panel">
            <div class="list-header">
              <span class="list-title">등록된 라운지</span>
              <span class="list-count" id="nlLoungeListCount">-</span>
            </div>
            <div id="nl-lounge-list"><div class="sk sk--sm"></div></div>
          </div>
        </div>`;

      try {
        const { lounges } = await apiFetch(`/naver/lounges?workspaceId=${WS}`);
        document.getElementById('nlLoungeListCount').textContent = lounges.length;
        const $list = document.getElementById('nl-lounge-list');
        $list.innerHTML = lounges.length === 0
          ? '<div class="ch-empty"><div class="text-center-muted">등록된 라운지 없음</div></div>'
          : lounges.map(nlLoungeRowHTML).join('');
      } catch (err) {
        document.getElementById('nl-lounge-list').innerHTML =
          `<div class="state-wrap"><div class="state-title">불러오기 실패</div><div class="state-desc">${escapeHtml(err.message)}</div></div>`;
      }
    }

    function nlLoungeRowHTML(g) {
      const isActive = g.isActive !== false;
      const recipients = (g.deliveryConfig?.email?.recipients || []).join(', ');
      const isEmailEnabled = g.deliveryConfig?.email?.isEnabled ?? false;
      const panelId = `nl-settings-${g.docId}`;
      const selectedModel = NL_ANALYSIS_MODELS.some(m => m.value === g.analysisModel)
        ? g.analysisModel
        : NL_ANALYSIS_MODELS[0].value;

      return `
        <div class="ch-row ${isActive ? '' : 'inactive'}" id="nlrow-${g.docId}">
          <div class="ch-row-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;color:#03C75A"><path d="M16.273 12.845 7.376 0H0v24h7.727V11.155L16.624 24H24V0h-7.727z"/></svg>
          </div>
          <div class="ch-row-info">
            <div class="ch-row-name">${escapeHtml(g.loungeName || g.loungeId)}</div>
            <div class="ch-row-meta">${escapeHtml(g.loungeUrl || '')}</div>
          </div>
          <div class="ch-row-status ${isActive ? 'active' : 'inactive'}">${isActive ? '활성' : '비활성'}</div>
          <div class="ch-row-actions">
            <div class="action-btn settings" data-docid="${escapeHtml(g.docId)}"
                 onclick="toggleNlLoungeSettings(this.dataset.docid)" title="설정">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </div>
            <div class="action-btn ${isActive ? 'toggle-on' : 'toggle-off'}"
                 data-docid="${escapeHtml(g.docId)}"
                 onclick="toggleNlLounge(this.dataset.docid, ${isActive})"
                 title="${isActive ? '비활성화' : '활성화'}">
              ${isActive
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728L5.636 5.636"/></svg>`
                : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`}
            </div>
            <div class="action-btn del"
                 data-docid="${escapeHtml(g.docId)}" data-name="${escapeHtml(g.loungeName || g.loungeId || '')}"
                 onclick="deleteNlLounge(this.dataset.docid, this.dataset.name)"
                 title="라운지 삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </div>
          </div>
        </div>
        <div class="ch-settings-panel" id="${panelId}">
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              이메일 리포트
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="nlEmailEnabled-${g.docId}" ${isEmailEnabled ? 'checked' : ''}>
              <span style="font-size:.875rem">이메일 발송 활성화</span>
            </label>
            <textarea class="settings-textarea" id="nlEmailRecipients-${g.docId}"
              placeholder="수신자 이메일 (쉼표 구분)">${escapeHtml(recipients)}</textarea>
            <button class="btn-save-settings" data-docid="${escapeHtml(g.docId)}"
                    onclick="saveNlLoungeSettings(this.dataset.docid)">저장</button>
            <div class="add-result" id="nlSaveResult-${g.docId}"></div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
              AI 분석 지시문
            </div>
            <label class="settings-field-label" for="nlAnalysisModel-${g.docId}">AI 모델</label>
            <select class="settings-select" id="nlAnalysisModel-${g.docId}">
              ${NL_ANALYSIS_MODELS.map(m => `
                <option value="${escapeHtml(m.value)}" ${selectedModel === m.value ? 'selected' : ''}>
                  ${escapeHtml(m.label)}
                </option>
              `).join('')}
            </select>
            <textarea class="settings-textarea" id="nlAnalysisPrompt-${g.docId}"
              rows="3" placeholder="예: 부정적 반응 위주로 분석해줘.">${escapeHtml(g.analysisPrompt || '')}</textarea>
            <button class="btn-save-settings" data-docid="${escapeHtml(g.docId)}"
                    onclick="saveNlLoungeSettings(this.dataset.docid)">저장</button>
          </div>
        </div>`;
    }

    function toggleNlLoungeSettings(docId) {
      const panel = document.getElementById(`nl-settings-${docId}`);
      if (panel) panel.classList.toggle('open');
    }

    async function addNlLounge() {
      const loungeName = document.getElementById('nlNewLoungeName')?.value.trim() || '';
      const loungeUrl  = document.getElementById('nlNewLoungeUrl')?.value.trim() || '';
      const $result = document.getElementById('nlAddResult');
      if (!loungeUrl) { $result.textContent = 'URL을 입력하세요.'; return; }
      try {
        $result.textContent = '추가 중…';
        await apiFetch('/naver/lounges', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, loungeUrl, loungeName }),
        });
        await loadNlLounges();
      } catch (err) {
        $result.textContent = '오류: ' + err.message;
      }
    }

    async function toggleNlLounge(docId, currentActive) {
      try {
        await apiFetch(`/naver/lounges?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !currentActive }),
        });
        await loadNlLounges();
      } catch (err) { alert('변경 실패: ' + err.message); }
    }

    async function saveNlLoungeSettings(docId) {
      const isEnabled  = document.getElementById(`nlEmailEnabled-${docId}`)?.checked ?? false;
      const recipients = (document.getElementById(`nlEmailRecipients-${docId}`)?.value || '')
        .split(/[,\n]/).map(e => e.trim()).filter(Boolean);
      const analysisPrompt = document.getElementById(`nlAnalysisPrompt-${docId}`)?.value || '';
      const analysisModel  = document.getElementById(`nlAnalysisModel-${docId}`)?.value || NL_ANALYSIS_MODELS[0].value;
      const $result = document.getElementById(`nlSaveResult-${docId}`);
      try {
        await apiFetch(`/naver/lounges/settings?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deliveryConfig: { email: { isEnabled, recipients } },
            analysisPrompt,
            analysisModel,
          }),
        });
        if ($result) { $result.textContent = '✓ 저장됨'; $result.style.color = 'var(--pos)'; setTimeout(() => { if ($result) $result.textContent = ''; }, 2000); }
        await loadNlLounges();
      } catch (err) {
        if ($result) { $result.textContent = '저장 실패: ' + err.message; $result.style.color = 'var(--neg)'; }
      }
    }

    async function deleteNlLounge(docId, loungeName) {
      const ok = await confirmDialog(`"${loungeName}" 라운지를 삭제하시겠습니까?`);
      if (!ok) return;
      try {
        await apiFetch(`/naver/lounges?workspaceId=${WS}&docId=${docId}`, { method: 'DELETE' });
        await loadNlLounges();
      } catch (err) { alert('삭제 실패: ' + err.message); }
    }

    // ── 세션 관리 ────────────────────────────────────────────
    async function checkNlSessionAlert() {
      try {
        const status = await apiFetch(`/naver/session/status?workspaceId=${WS}`);
        const $dot = document.getElementById('nl-session-alert');
        if ($dot) $dot.style.display = (status.exists && !status.isValid) ? 'inline-block' : 'none';
      } catch (_) {}
    }

    async function loadNlSession() {
      const $main = document.getElementById('nl-session-main');
      if (!$main) return;
      try {
        const status = await apiFetch(`/naver/session/status?workspaceId=${WS}`);

        const isValid  = status.isValid;
        const exists   = status.exists;
        const badgeColor  = isValid ? '#16a34a' : '#dc2626';
        const badgeBg     = isValid ? '#f0fdf4' : '#fef2f2';
        const badgeBorder = isValid ? '#bbf7d0' : '#fecaca';
        const badgeText   = !exists ? '세션 없음' : isValid ? '세션 유효' : '세션 만료됨';
        const badgeDesc   = !exists
          ? '등록된 세션이 없습니다. 아래에서 쿠키를 등록하세요.'
          : isValid
          ? '로그인 상태가 유효합니다. 파이프라인이 정상 실행됩니다.'
          : '세션이 만료되었습니다. 쿠키를 다시 등록해주세요.';

        $main.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start">

            <!-- 왼쪽: 쿠키 등록 폼 -->
            <div class="panel-card">
              <div class="panel-title">쿠키 등록</div>

              <!-- 안내 박스 -->
              <div style="display:flex;gap:10px;padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;margin-bottom:16px">
                <svg style="flex-shrink:0;margin-top:1px" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <div style="font-size:12.5px;color:#1e40af;line-height:1.6">
                  브라우저에서 대상 요청을 한 번 성공시킨 뒤<br>
                  <strong>DevTools (F12) → Network → Request Headers</strong>에서<br>
                  <code>cookie</code>, <code>deviceid</code>, <code>user-agent</code>, <code>referer</code> 값을 복사해 입력하세요.
                </div>
              </div>

              <div style="display:flex;flex-direction:column;gap:14px;margin-bottom:14px">
                <div>
                  <label style="display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:6px">Cookie Header</label>
                  <textarea
                    id="nlCookieHeaderInput"
                    rows="6"
                    style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;resize:vertical;outline:none;color:#1e293b;background:#f8fafc;line-height:1.5"
                    placeholder='NID_AUT=...; NID_SES=...; NAC=...'
                  ></textarea>
                </div>
                <div>
                  <label style="display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:6px">Device ID</label>
                  <input
                    id="nlDeviceIdInput"
                    type="text"
                    style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;outline:none;color:#1e293b;background:#f8fafc;line-height:1.5"
                    placeholder='c7fde872-dcc4-4ae3-b8b6-ee70a7ea4218'
                  />
                </div>
                <div>
                  <label style="display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:6px">User-Agent</label>
                  <textarea
                    id="nlUserAgentInput"
                    rows="3"
                    style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;resize:vertical;outline:none;color:#1e293b;background:#f8fafc;line-height:1.5"
                    placeholder='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...'
                  ></textarea>
                </div>
                <div>
                  <label style="display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:6px">Referer</label>
                  <input
                    id="nlRefererInput"
                    type="text"
                    style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;outline:none;color:#1e293b;background:#f8fafc;line-height:1.5"
                    placeholder='https://game.naver.com/lounge/Soul_Strike/board/11'
                  />
                </div>
              </div>

              <!-- 버튼 -->
              <div style="display:flex;gap:8px">
                <button class="btn-primary" style="flex:1" onclick="saveNlSessionProfile()">
                  세션 저장
                </button>
                ${exists ? `
                <button class="btn-secondary" onclick="deleteNlSession()" style="padding:0 16px">
                  세션 삭제
                </button>` : ''}
              </div>
            </div>

            <!-- 오른쪽: 세션 상태 -->
            <div style="display:flex;flex-direction:column;gap:14px">

              <!-- 상태 뱃지 카드 -->
              <div class="panel-card" style="padding:20px">
                <div class="panel-title" style="margin-bottom:14px">세션 상태</div>
                <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:${badgeBg};border:1px solid ${badgeBorder};border-radius:10px">
                  <span style="width:10px;height:10px;border-radius:50%;background:${badgeColor};flex-shrink:0;
                    ${isValid ? 'box-shadow:0 0 0 3px rgba(22,163,74,.2)' : ''}"></span>
                  <div>
                    <div style="font-size:13px;font-weight:700;color:#1e293b">${badgeText}</div>
                    <div style="font-size:11.5px;color:#64748b;margin-top:2px">${badgeDesc}</div>
                  </div>
                </div>
              </div>

              <!-- 상세 정보 카드 (세션이 있을 때만) -->
              ${exists ? `
              <div class="panel-card" style="padding:20px">
                <div class="panel-title" style="margin-bottom:12px">저장 정보</div>
                <div style="display:flex;flex-direction:column;gap:10px">
                  <div class="row-between">
                    <span style="color:#64748b">쿠키 수</span>
                    <span style="font-weight:600;color:#1e293b">${status.cookieCount || 0}개</span>
                  </div>
                  <div class="row-between">
                    <span style="color:#64748b">요청 프로필</span>
                    <span style="font-weight:600;color:#1e293b">${status.hasRequestProfile ? '등록됨' : '미완성'}</span>
                  </div>
                  ${status.deviceId ? `
                  <div style="display:flex;justify-content:space-between;align-items:center;font-size:12.5px;gap:12px">
                    <span style="color:#64748b">Device ID</span>
                    <span style="font-weight:500;color:#1e293b;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px">${escapeHtml(status.deviceId)}</span>
                  </div>` : ''}
                  ${status.savedAt ? `
                  <div class="row-between">
                    <span style="color:#64748b">저장일시</span>
                    <span style="font-weight:500;color:#1e293b">${new Date(status.savedAt).toLocaleString('ko-KR', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
                  </div>` : ''}
                  ${status.lastValidatedAt ? `
                  <div class="row-between">
                    <span style="color:#64748b">마지막 확인</span>
                    <span style="font-weight:500;color:#1e293b">${new Date(status.lastValidatedAt).toLocaleString('ko-KR', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
                  </div>` : ''}
                </div>
              </div>` : ''}

            </div>
          </div>`;
        checkNlSessionAlert();
      } catch (err) {
        $main.innerHTML = `<div class="error-state">오류: ${err.message}</div>`;
      }
    }

    async function saveNlSessionProfile() {
      const cookieHeader = document.getElementById('nlCookieHeaderInput')?.value.trim() || '';
      const deviceId = document.getElementById('nlDeviceIdInput')?.value.trim() || '';
      const userAgent = document.getElementById('nlUserAgentInput')?.value.trim() || '';
      const referer = document.getElementById('nlRefererInput')?.value.trim() || '';
      if (!cookieHeader) { alert('Cookie Header를 입력하세요.'); return; }
      if (!deviceId) { alert('Device ID를 입력하세요.'); return; }
      if (!userAgent) { alert('User-Agent를 입력하세요.'); return; }
      try {
        const res = await apiFetch('/naver/session', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, cookieHeader, deviceId, userAgent, referer }),
        });
        alert(`세션 저장 완료 (쿠키 ${res.cookieCount ?? 0}개)`);
        await loadNlSession();
      } catch (err) { alert('저장 실패: ' + err.message); }
    }

    async function deleteNlSession() {
      const ok = await confirmDialog('저장된 네이버 요청 세션을 삭제하시겠습니까?');
      if (!ok) return;
      try {
        await apiFetch(`/naver/session?workspaceId=${WS}`, { method: 'DELETE' });
        await loadNlSession();
      } catch (err) { alert('삭제 실패: ' + err.message); }
    }

    // ═══════════════════════════════════════════════════════
    //  디시인사이드 — 일별 리포트
    // ═══════════════════════════════════════════════════════

    async function refreshDcAvailableDates() {
      try {
        const { dates } = await apiFetch(`/dcinside/available-dates?workspaceId=${WS}`);
        _availableDcDates = dates || [];
        if (_fpDcDatePicker) {
          if (_availableDcDates.length > 0) {
            _fpDcDatePicker.set('enable', _availableDcDates);
            _fpDcDatePicker.setDate(_availableDcDates[_availableDcDates.length - 1], true);
          } else {
            _fpDcDatePicker.set('enable', [() => true]);
          }
        }
      } catch (_) {}
    }

    async function triggerDcReport() {
      const date = document.getElementById('dcReportDate')?.value;
      const $btn = document.getElementById('dcTriggerBtn');
      if (!date) { alert('날짜를 선택하세요.'); return; }
      if ($btn) { $btn.disabled = true; $btn.textContent = '실행 중…'; }
      try {
        await apiFetch('/dcinside/pipeline/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, date, skipEmail: true }),
        });
        await refreshDcAvailableDates();
        await loadDcReport();
      } catch (err) {
        alert('오류: ' + err.message);
      } finally {
        if ($btn) { $btn.disabled = false; $btn.textContent = '리포트 생성'; }
      }
    }

    async function loadDcReport() {
      const $main = document.getElementById('dc-report-main');
      if (!$main) return;
      const date = document.getElementById('dcReportDate')?.value;
      if (!date) { $main.innerHTML = '<div class="state-wrap"><div class="state-title">날짜를 선택하세요</div></div>'; return; }
      $main.innerHTML = '<div class="sk sk--sm"></div>';
      try {
        const { reports } = await apiFetch(`/dcinside/report?workspaceId=${WS}&date=${date}`);
        if (!reports || reports.length === 0) {
          $main.innerHTML = '<div class="state-wrap"><div class="state-title">리포트 없음</div><div class="state-desc">해당 날짜의 수집 데이터가 없습니다.</div></div>';
          return;
        }
        $main.innerHTML = reports.map(buildDcReportCard).join('');
        requestAnimationFrame(() => requestAnimationFrame(() => {
          $main.querySelectorAll('.sent-seg[data-v]').forEach(el => { el.style.width = el.dataset.v + '%'; });
        }));
      } catch (err) {
        $main.innerHTML = `<div class="error-state">오류: ${err.message}</div>`;
      }
    }

    function buildDcReportCard(r) {
      const sentiment = r.aiSentiment || {};
      const pos = sentiment.positive ?? 0;
      const neu = sentiment.neutral ?? 0;
      const neg = sentiment.negative ?? 0;
      const typeBadge = r.galleryType === 'minor'
        ? `<span class="badge" style="background:#fff0f0;color:#e5171e;border:1px solid #fecaca">마이너 갤러리</span>`
        : `<span class="badge" style="background:#f0f4ff;color:#2563eb;border:1px solid #bfdbfe">일반 갤러리</span>`;
      const crawlBadge = r.crawlStatus === 'partial'
        ? `<span class="badge alert">부분 수집</span>`
        : r.crawlStatus === 'session_expired'
        ? `<span class="badge alert">세션 만료</span>`
        : '';

      const issues = (r.aiIssues || []).map(issue => {
        const sev = severity(issue.count || 1);
        return `<div class="issue-card ${sev.cls}">
          <div class="issue-sev-bar"></div>
          <div class="issue-count-badge">${issue.count || 1}</div>
          <div class="issue-body">
            <div class="issue-title">${escapeHtml(issue.title || '')}</div>
            <div class="issue-desc">${escapeHtml(issue.description || '')}</div>
          </div>
          <div class="issue-sev-label">${sev.label}</div>
        </div>`;
      }).join('');

      const tokenStrip = (r.model || r.totalTokens) ? `
        <div class="token-info-strip">
          ${r.model ? `<span class="token-model">${escapeHtml(r.model)}</span>` : ''}
          ${r.totalTokens ? `<span>입력 ${(r.promptTokens||0).toLocaleString()} / 출력 ${(r.completionTokens||0).toLocaleString()} / 합계 ${(r.totalTokens||0).toLocaleString()} 토큰</span>` : ''}
          ${r.cost != null ? `<span>비용 $${Number(r.cost).toFixed(4)}</span>` : ''}
        </div>` : '';

      return `
      <div class="ch-card anim d1">
        <div class="ch-header anim d1">
          <div class="ch-platform-icon" style="color:#e5171e">${SVG_DC}</div>
          <div>
            <div class="ch-name">${escapeHtml(r.galleryName || r.galleryId || '')}</div>
            <div class="ch-meta">
              ${r.postCount != null ? `게시글 ${r.postCount}개` : ''}
              ${r.totalComments != null ? ` &nbsp;·&nbsp; 댓글 ${r.totalComments.toLocaleString()}개` : ''}
              ${r.totalViews != null ? ` &nbsp;·&nbsp; 조회 ${r.totalViews.toLocaleString()}` : ''}
              ${r.aiIssues?.length != null ? ` &nbsp;·&nbsp; 이슈 ${r.aiIssues.length}건` : ''}
              ${typeBadge} ${crawlBadge}
            </div>
          </div>
        </div>

        <div class="scard anim d2">
          <div class="slabel"><div class="slabel-dot"></div>${SVG.doc}갤러리 동향 요약</div>
          <p class="summary-body">${formatSummary(r.aiSummary)}</p>
        </div>

        <div class="scard anim d3">
          <div class="slabel"><div class="slabel-dot"></div>${SVG.bar}감정 분석</div>
          <div class="sent-wrap">
            <div class="sent-spectrum">
              <div class="sent-seg pos" data-v="${pos}" style="width:0%"></div>
              <div class="sent-seg neu" data-v="${neu}" style="width:0%"></div>
              <div class="sent-seg neg" data-v="${neg}" style="width:0%"></div>
            </div>
            <div class="sent-tiles">
              <div class="sent-tile"><div class="sent-tile-val pos">${pos}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">긍정</div></div>
              <div class="sent-tile"><div class="sent-tile-val neu">${neu}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">중립</div></div>
              <div class="sent-tile"><div class="sent-tile-val neg">${neg}<span class="sent-tile-unit">%</span></div><div class="sent-tile-lbl">부정</div></div>
            </div>
          </div>
        </div>

        <div class="scard anim d4" style="margin-top:1rem">
          <div class="slabel"><div class="slabel-dot"></div>${SVG.warn}주요 이슈 <span class="slabel-count">${r.aiIssues?.length || 0}건</span></div>
          ${issues || `<div style="color:var(--text-3);font-size:.875rem;line-height:1.8">오늘은 별도로 부각된 주요 이슈가 감지되지 않았습니다.</div>`}
        </div>

        ${tokenStrip}
      </div>`;
    }

    // ── 갤러리 관리 ──────────────────────────────────────────
    async function loadDcGalleries() {
      const $main = document.getElementById('dc-galleries-main');
      if (!$main) return;

      $main.innerHTML = `
        <div class="ch-mgmt-grid">
          <div class="add-panel">
            <div class="panel-title">갤러리 추가</div>
            <div class="panel-desc">모니터링할 디시인사이드 갤러리 URL을 등록합니다.</div>
            <div class="field-group">
              <label class="field-label">갤러리 이름 <span style="color:var(--text-muted);font-size:.75rem">(선택)</span></label>
              <input class="field-input" id="dcNewGalleryName" type="text" placeholder="예: 프로그래밍 갤러리" autocomplete="off">
            </div>
            <div class="field-group">
              <label class="field-label">갤러리 URL <span class="text-neg">*</span></label>
              <input class="field-input" id="dcNewGalleryUrl" type="text" placeholder="https://gall.dcinside.com/board/lists/?id=programming" autocomplete="off">
            </div>
            <button class="btn-add" onclick="addDcGallery()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              갤러리 추가
            </button>
            <div class="add-result" id="dcAddResult"></div>
          </div>
          <div class="list-panel">
            <div class="list-header">
              <span class="list-title">등록된 갤러리</span>
              <span class="list-count" id="dcGalleryListCount">-</span>
            </div>
            <div id="dc-gallery-list"><div class="sk sk--sm"></div></div>
          </div>
        </div>`;

      try {
        const { galleries } = await apiFetch(`/dcinside/galleries?workspaceId=${WS}`);
        document.getElementById('dcGalleryListCount').textContent = galleries.length;
        const $list = document.getElementById('dc-gallery-list');
        $list.innerHTML = galleries.length === 0
          ? '<div class="ch-empty"><div class="text-center-muted">등록된 갤러리 없음</div></div>'
          : galleries.map(dcGalleryRowHTML).join('');
      } catch (err) {
        document.getElementById('dc-gallery-list').innerHTML =
          `<div class="state-wrap"><div class="state-title">불러오기 실패</div><div class="state-desc">${escapeHtml(err.message)}</div></div>`;
      }
    }

    function dcGalleryRowHTML(g) {
      const isActive = g.isActive !== false;
      const recipients = (g.deliveryConfig?.email?.recipients || []).join(', ');
      const isEmailEnabled = g.deliveryConfig?.email?.isEnabled ?? false;
      const panelId = `dc-settings-${g.docId}`;
      const selectedModel = DC_ANALYSIS_MODELS.some(m => m.value === g.analysisModel)
        ? g.analysisModel
        : DC_ANALYSIS_MODELS[0].value;
      const typeBadge = g.galleryType === 'minor'
        ? `<span class="badge" style="background:#fff0f0;color:#e5171e;border:1px solid #fecaca;font-size:10px">마이너</span>`
        : `<span class="badge" style="background:#f0f4ff;color:#2563eb;border:1px solid #bfdbfe;font-size:10px">일반</span>`;

      return `
        <div class="ch-row ${isActive ? '' : 'inactive'}" id="dcrow-${g.docId}">
          <div class="ch-row-icon">
            <img src="/dc-icon.png" style="width:20px;height:20px;border-radius:4px;object-fit:cover" alt="DCInside">
          </div>
          <div class="ch-row-info">
            <div class="ch-row-name">${escapeHtml(g.galleryName || g.galleryId || '')} ${typeBadge}</div>
            <div class="ch-row-meta">${escapeHtml(g.galleryUrl || '')}</div>
          </div>
          <div class="ch-row-status ${isActive ? 'active' : 'inactive'}">${isActive ? '활성' : '비활성'}</div>
          <div class="ch-row-actions">
            <div class="action-btn settings" data-docid="${escapeHtml(g.docId)}"
                 onclick="toggleDcGallerySettings(this.dataset.docid)" title="설정">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </div>
            <div class="action-btn ${isActive ? 'toggle-on' : 'toggle-off'}"
                 data-docid="${escapeHtml(g.docId)}"
                 onclick="toggleDcGallery(this.dataset.docid, ${isActive})"
                 title="${isActive ? '비활성화' : '활성화'}">
              ${isActive
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728L5.636 5.636"/></svg>`
                : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`}
            </div>
            <div class="action-btn del"
                 data-docid="${escapeHtml(g.docId)}" data-name="${escapeHtml(g.galleryName || g.galleryId || '')}"
                 onclick="deleteDcGallery(this.dataset.docid, this.dataset.name)"
                 title="갤러리 삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </div>
          </div>
        </div>
        <div class="ch-settings-panel" id="${panelId}">
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              이메일 리포트
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="dcEmailEnabled-${g.docId}" ${isEmailEnabled ? 'checked' : ''}>
              <span style="font-size:.875rem">이메일 발송 활성화</span>
            </label>
            <textarea class="settings-textarea" id="dcEmailRecipients-${g.docId}"
              placeholder="수신자 이메일 (쉼표 구분)">${escapeHtml(recipients)}</textarea>
            <button class="btn-save-settings" data-docid="${escapeHtml(g.docId)}"
                    onclick="saveDcGallerySettings(this.dataset.docid)">저장</button>
            <div class="add-result" id="dcSaveResult-${g.docId}"></div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
              AI 분석 지시문
            </div>
            <label class="settings-field-label" for="dcAnalysisModel-${g.docId}">AI 모델</label>
            <select class="settings-select" id="dcAnalysisModel-${g.docId}">
              ${DC_ANALYSIS_MODELS.map(m => `
                <option value="${escapeHtml(m.value)}" ${selectedModel === m.value ? 'selected' : ''}>
                  ${escapeHtml(m.label)}
                </option>
              `).join('')}
            </select>
            <textarea class="settings-textarea" id="dcAnalysisPrompt-${g.docId}"
              rows="3" placeholder="예: 부정적 반응 위주로 분석해줘.">${escapeHtml(g.analysisPrompt || '')}</textarea>
            <button class="btn-save-settings" data-docid="${escapeHtml(g.docId)}"
                    onclick="saveDcGallerySettings(this.dataset.docid)">저장</button>
          </div>
        </div>`;
    }

    function toggleDcGallerySettings(docId) {
      const panel = document.getElementById(`dc-settings-${docId}`);
      if (panel) panel.classList.toggle('open');
    }

    async function addDcGallery() {
      const galleryName = document.getElementById('dcNewGalleryName')?.value.trim() || '';
      const galleryUrl  = document.getElementById('dcNewGalleryUrl')?.value.trim() || '';
      const $result = document.getElementById('dcAddResult');
      if (!galleryUrl) { $result.textContent = 'URL을 입력하세요.'; return; }
      try {
        $result.textContent = '추가 중…';
        await apiFetch('/dcinside/galleries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, galleryUrl, galleryName }),
        });
        await loadDcGalleries();
      } catch (err) {
        $result.textContent = '오류: ' + err.message;
      }
    }

    async function toggleDcGallery(docId, currentActive) {
      try {
        await apiFetch(`/dcinside/galleries?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !currentActive }),
        });
        await loadDcGalleries();
      } catch (err) { alert('변경 실패: ' + err.message); }
    }

    async function saveDcGallerySettings(docId) {
      const isEnabled  = document.getElementById(`dcEmailEnabled-${docId}`)?.checked ?? false;
      const recipients = (document.getElementById(`dcEmailRecipients-${docId}`)?.value || '')
        .split(/[,\n]/).map(e => e.trim()).filter(Boolean);
      const analysisPrompt = document.getElementById(`dcAnalysisPrompt-${docId}`)?.value || '';
      const analysisModel  = document.getElementById(`dcAnalysisModel-${docId}`)?.value || DC_ANALYSIS_MODELS[0].value;
      const $result = document.getElementById(`dcSaveResult-${docId}`);
      try {
        await apiFetch(`/dcinside/galleries/settings?workspaceId=${WS}&docId=${encodeURIComponent(docId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deliveryConfig: { email: { isEnabled, recipients } },
            analysisPrompt,
            analysisModel,
          }),
        });
        if ($result) { $result.textContent = '✓ 저장됨'; $result.style.color = 'var(--pos)'; setTimeout(() => { if ($result) $result.textContent = ''; }, 2000); }
        await loadDcGalleries();
      } catch (err) {
        if ($result) { $result.textContent = '저장 실패: ' + err.message; $result.style.color = 'var(--neg)'; }
      }
    }

    async function deleteDcGallery(docId, galleryName) {
      const ok = await confirmDialog(`"${galleryName}" 갤러리를 삭제하시겠습니까?`);
      if (!ok) return;
      try {
        await apiFetch(`/dcinside/galleries?workspaceId=${WS}&docId=${docId}`, { method: 'DELETE' });
        await loadDcGalleries();
      } catch (err) { alert('삭제 실패: ' + err.message); }
    }

    // ── 세션 관리 ─────────────────────────────────────────────
    async function checkDcSessionAlert() {
      try {
        const status = await apiFetch(`/dcinside/session/status?workspaceId=${WS}`);
        const $dot = document.getElementById('dc-session-alert');
        if ($dot) $dot.style.display = (status.exists && !status.isValid) ? 'inline-block' : 'none';
      } catch (_) {}
    }

    async function loadDcSession() {
      const $main = document.getElementById('dc-session-main');
      if (!$main) return;
      try {
        const status = await apiFetch(`/dcinside/session/status?workspaceId=${WS}`);

        const isValid  = status.isValid;
        const exists   = status.exists;
        const badgeColor  = isValid ? '#16a34a' : '#dc2626';
        const badgeBg     = isValid ? '#f0fdf4' : '#fef2f2';
        const badgeBorder = isValid ? '#bbf7d0' : '#fecaca';
        const badgeText   = !exists ? '세션 없음' : isValid ? '세션 유효' : '세션 만료됨';
        const badgeDesc   = !exists
          ? '등록된 세션이 없습니다. 아래에서 쿠키를 등록하세요.'
          : isValid
          ? '로그인 상태가 유효합니다. 파이프라인이 정상 실행됩니다.'
          : '세션이 만료되었습니다. 쿠키를 다시 등록해주세요.';

        $main.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start">

            <!-- 왼쪽: 쿠키 등록 폼 -->
            <div class="panel-card">
              <div class="panel-title">쿠키 등록</div>

              <div style="display:flex;gap:10px;padding:12px 14px;background:#fff8f8;border:1px solid #fecaca;border-radius:8px;margin-bottom:16px">
                <svg style="flex-shrink:0;margin-top:1px" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e5171e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <div style="font-size:12.5px;color:#7f1d1d;line-height:1.6">
                  브라우저에서 디시인사이드에 로그인한 뒤<br>
                  <strong>DevTools (F12) → Network → Request Headers</strong>에서<br>
                  <code>cookie</code>, <code>user-agent</code> 값을 복사해 입력하세요.
                </div>
              </div>

              <div style="display:flex;flex-direction:column;gap:14px;margin-bottom:14px">
                <div>
                  <label style="display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:6px">Cookie Header</label>
                  <textarea
                    id="dcCookieHeaderInput"
                    rows="6"
                    style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;resize:vertical;outline:none;color:#1e293b;background:#f8fafc;line-height:1.5"
                    placeholder='_ga=...; dc_session=...; PHPSESSID=...'
                  ></textarea>
                </div>
                <div>
                  <label style="display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:6px">User-Agent</label>
                  <textarea
                    id="dcUserAgentInput"
                    rows="3"
                    style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;resize:vertical;outline:none;color:#1e293b;background:#f8fafc;line-height:1.5"
                    placeholder='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...'
                  ></textarea>
                </div>
              </div>

              <div style="display:flex;gap:8px">
                <button class="btn-primary" style="flex:1;background:#e5171e;border-color:#e5171e" onclick="saveDcSessionProfile()">
                  세션 저장
                </button>
                ${exists ? `
                <button class="btn-secondary" onclick="deleteDcSession()" style="padding:0 16px">
                  세션 삭제
                </button>` : ''}
              </div>
            </div>

            <!-- 오른쪽: 세션 상태 -->
            <div style="display:flex;flex-direction:column;gap:14px">

              <div class="panel-card" style="padding:20px">
                <div class="panel-title" style="margin-bottom:14px">세션 상태</div>
                <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:${badgeBg};border:1px solid ${badgeBorder};border-radius:10px">
                  <span style="width:10px;height:10px;border-radius:50%;background:${badgeColor};flex-shrink:0;
                    ${isValid ? 'box-shadow:0 0 0 3px rgba(22,163,74,.2)' : ''}"></span>
                  <div>
                    <div style="font-size:13px;font-weight:700;color:#1e293b">${badgeText}</div>
                    <div style="font-size:11.5px;color:#64748b;margin-top:2px">${badgeDesc}</div>
                  </div>
                </div>
              </div>

              ${exists ? `
              <div class="panel-card" style="padding:20px">
                <div class="panel-title" style="margin-bottom:12px">저장 정보</div>
                <div style="display:flex;flex-direction:column;gap:10px">
                  ${status.savedAt ? `
                  <div class="row-between">
                    <span style="color:#64748b">저장일시</span>
                    <span style="font-weight:500;color:#1e293b">${new Date(status.savedAt).toLocaleString('ko-KR', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
                  </div>` : ''}
                  ${status.lastValidatedAt ? `
                  <div class="row-between">
                    <span style="color:#64748b">마지막 확인</span>
                    <span style="font-weight:500;color:#1e293b">${new Date(status.lastValidatedAt).toLocaleString('ko-KR', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
                  </div>` : ''}
                </div>
              </div>` : ''}

            </div>
          </div>`;
        checkDcSessionAlert();
      } catch (err) {
        $main.innerHTML = `<div class="error-state">오류: ${err.message}</div>`;
      }
    }

    async function saveDcSessionProfile() {
      const cookieHeader = document.getElementById('dcCookieHeaderInput')?.value.trim() || '';
      const userAgent = document.getElementById('dcUserAgentInput')?.value.trim() || '';
      if (!cookieHeader) { alert('Cookie Header를 입력하세요.'); return; }
      if (!userAgent) { alert('User-Agent를 입력하세요.'); return; }
      try {
        await apiFetch('/dcinside/session', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, cookieHeader, userAgent }),
        });
        alert('세션 저장 완료');
        await loadDcSession();
      } catch (err) { alert('저장 실패: ' + err.message); }
    }

    async function deleteDcSession() {
      const ok = await confirmDialog('저장된 디시인사이드 세션을 삭제하시겠습니까?');
      if (!ok) return;
      try {
        await apiFetch(`/dcinside/session?workspaceId=${WS}`, { method: 'DELETE' });
        await loadDcSession();
      } catch (err) { alert('삭제 실패: ' + err.message); }
    }

    // ═══════════════════════════════════════════════════════
    //  공용 유틸: confirmDialog (간단한 삭제 확인용)
    // ═══════════════════════════════════════════════════════

    function confirmDialog(message) {
      return Promise.resolve(window.confirm(message));
    }

    // ═══════════════════════════════════════════════════════
    //  리포트 프리셋 관리
    // ═══════════════════════════════════════════════════════

    /** 플랫폼별 메타 */
    const PRESET_PLATFORM_META = {
      discord: {
        label: 'Discord', color: '#5865F2', emailIcon: '🎮', cls: 'preset-block--discord',
        icon: `<svg viewBox="0 0 24 24" fill="currentColor" style="width:13px;height:13px;flex-shrink:0;color:var(--discord)"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`,
      },
      instagram: {
        label: 'Instagram', color: '#E1306C', emailIcon: '📸', cls: 'preset-block--instagram',
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="width:13px;height:13px;flex-shrink:0;color:#E1306C"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`,
      },
      facebook: {
        label: 'Facebook 그룹', color: '#1877F2', emailIcon: '👥', cls: 'preset-block--facebook',
        icon: `<svg viewBox="0 0 24 24" fill="currentColor" style="width:13px;height:13px;flex-shrink:0;color:#1877F2"><path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97h-1.513c-1.491 0-1.956.93-1.956 1.886v2.267h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/></svg>`,
      },
      naver_lounge: {
        label: '네이버 라운지', color: '#03C75A', emailIcon: '🏪', cls: 'preset-block--naver_lounge',
        icon: `<svg viewBox="0 0 24 24" fill="currentColor" style="width:13px;height:13px;flex-shrink:0;color:#03C75A"><path d="M16.273 12.845 7.376 0H0v24h7.727V11.155L16.624 24H24V0h-7.727z"/></svg>`,
      },
    };

    /** 플랫폼별 프리뷰 목업 데이터 */
    const PREVIEW_MOCK = {
      discord: {
        messageCount: 128,
        summary: '오늘은 신규 업데이트 관련 긍정적인 반응이 많았습니다. 유저들의 참여도가 전반적으로 높았으며 커뮤니티 활동이 활발하게 이루어졌습니다.',
        issues: [
          { title: '서버 불안정 문의', description: '접속 오류를 경험한 유저 보고 다수', count: 12 },
          { title: '신규 콘텐츠 요청', description: '다음 업데이트 일정에 대한 문의 증가', count: 8 },
        ],
      },
      instagram: {
        aiPerformanceReview: '오늘 게시된 릴스 콘텐츠가 평균 대비 1.8배 높은 도달률을 기록했습니다. 팔로워 유입도 꾸준히 증가 추세입니다.',
        posts: [
          { caption: '새로운 컬렉션 출시!', likeCount: 312, commentsCount: 18, videoViewCount: 4200 },
          { caption: '오늘의 비하인드', likeCount: 198, commentsCount: 9, videoViewCount: 2100 },
        ],
      },
      facebook: {
        postCount: 15,
        aiSummary: '<p>이번 주 그룹 내 주요 화제는 신제품 출시였으며, 전반적으로 긍정적인 반응이 주를 이뤘습니다.</p>',
        aiIssues: [
          { title: '배송 지연 불만', description: '배송 지연 경험을 공유하는 게시글이 증가', count: 7 },
        ],
      },
      naver_lounge: {
        postCount: 22,
        aiSummary: '<p>라운지 내 이벤트 관련 게시글이 활발하게 공유되고 있으며, 커뮤니티 참여도가 높습니다.</p>',
        aiIssues: [
          { title: '이벤트 당첨 문의', description: '이벤트 결과 발표 관련 문의 급증', count: 11 },
        ],
      },
    };

    /** 편집 중인 프리셋 상태 */
    let _editingPresetId = null;     // null = 신규
    let _presetItems = [];           // 현재 구성된 드롭존 항목
    let _presetChipInput = null;     // ChipInput 인스턴스

    /* ── 발송 기록 ── */
    const DELIVERY_PLATFORM_LABEL = {
      discord:       { label: 'Discord',        color: '#5865f2' },
      instagram:     { label: 'Instagram',       color: '#e1306c' },
      facebook_page: { label: 'Facebook 페이지', color: '#1877f2' },
      naver_lounge:  { label: '네이버 라운지',   color: '#03c75a' },
    };

    async function loadDeliveryLog() {
      const $el = document.getElementById('delivery-log-main');
      $el.innerHTML = '<div class="data-log-empty">불러오는 중...</div>';
      try {
        const data = await apiFetch(`/delivery-logs?workspaceId=${WS}&limit=200`);
        renderDeliveryLog(data.logs || []);
      } catch (err) {
        $el.innerHTML = `<div class="data-log-empty" style="color:#f87171">오류: ${escapeHtml(err.message)}</div>`;
      }
    }

    function renderDeliveryLog(logs) {
      const $el = document.getElementById('delivery-log-main');
      if (!logs.length) {
        $el.innerHTML = '<div class="data-log-empty">발송 기록이 없습니다.</div>';
        return;
      }

      const rows = logs.map(log => {
        const p = DELIVERY_PLATFORM_LABEL[log.platform] || { label: log.platform, color: '#64748b' };
        const sentAt = log.sentAt
          ? new Date(log.sentAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          : '—';
        const langBadge = log.lang
          ? `<span class="dl-lang-badge">${log.lang.toUpperCase()}</span>`
          : '';
        const statusCls = log.status === 'success' ? 'dl-status-ok' : 'dl-status-err';
        const statusLabel = log.status === 'success' ? '성공' : '실패';
        return `
        <tr>
          <td class="dl-td dl-td-time">${sentAt}</td>
          <td class="dl-td"><span class="dl-platform-badge" style="background:${p.color}20;color:${p.color}">${p.label}</span></td>
          <td class="dl-td dl-td-target">${escapeHtml(log.target || '—')}</td>
          <td class="dl-td dl-td-date">${log.reportDate || '—'}</td>
          <td class="dl-td dl-td-count">${log.recipientCount ?? '—'}명${langBadge}</td>
          <td class="dl-td"><span class="${statusCls}">${statusLabel}</span></td>
        </tr>`;
      }).join('');

      $el.innerHTML = `
      <div class="dl-wrap">
        <div class="dl-summary">총 ${logs.length}건</div>
        <table class="dl-table">
          <thead>
            <tr>
              <th class="dl-th">발송 일시</th>
              <th class="dl-th">플랫폼</th>
              <th class="dl-th">대상</th>
              <th class="dl-th">리포트 날짜</th>
              <th class="dl-th">수신자</th>
              <th class="dl-th">상태</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

    /** 프리셋 목록 로드 및 렌더링 */
    async function loadPresets() {
      const $list = document.getElementById('preset-list-main');
      $list.innerHTML = '<div class="preset-list-empty">불러오는 중...</div>';
      try {
        const data = await apiFetch(`/report-presets?workspaceId=${WS}`);
        renderPresetList(data.presets || []);
      } catch (err) {
        $list.innerHTML = `<div class="preset-list-empty text-neg">오류: ${escapeHtml(err.message)}</div>`;
      }
    }

    function renderPresetList(presets) {
      const $list = document.getElementById('preset-list-main');
      if (!presets.length) {
        $list.innerHTML = '<div class="preset-list-empty">등록된 프리셋이 없습니다</div>';
        return;
      }
      $list.innerHTML = presets.map((p) => {
        const isActive = p.isActive !== false;
        const itemCount = (p.items || []).length;
        const recCount = (p.recipients || []).length;
        return `
          <div class="preset-list-item${_editingPresetId === p.presetId ? ' active' : ''}"
               data-preset-id="${p.presetId}"
               onclick="openPresetEditor(${JSON.stringify(p).replace(/"/g, '&quot;')})">
            <div class="preset-list-item-name">${escapeHtml(p.name)}</div>
            <div class="preset-list-item-meta">
              <span class="preset-active-badge preset-active-badge--${isActive ? 'on' : 'off'}">${isActive ? '활성' : '비활성'}</span>
              <span>${itemCount}개 리포트</span>
              <span>수신자 ${recCount}명</span>
            </div>
          </div>`;
      }).join('');
    }

    /** 편집기 열기 (preset = null이면 신규) */
    async function openPresetEditor(preset) {
      _editingPresetId = preset ? preset.presetId : null;
      _presetItems = preset ? JSON.parse(JSON.stringify(preset.items || [])) : [];

      document.getElementById('preset-editor-empty').style.display = 'none';
      document.getElementById('preset-editor-form').style.display = '';
      const $nameInput = document.getElementById('preset-name-input');
      $nameInput.value = preset ? preset.name : '';
      $nameInput.oninput = () => updateEmailPreview();

      // ChipInput 초기화
      if (!_presetChipInput) {
        _presetChipInput = new ChipInput('preset-chip-container');
      }
      _presetChipInput.setEmails(preset ? (preset.recipients || []) : []);

      // 드롭존 렌더링
      renderDropZone();

      // 사용 가능한 블록 로드
      await loadAvailableBlocks();

      // 목록 active 상태 갱신
      _highlightPresetListItem(_editingPresetId);
    }

    function _highlightPresetListItem(presetId) {
      document.querySelectorAll('.preset-list-item').forEach(el => {
        el.classList.toggle('active', el.dataset.presetId === presetId);
      });
    }

    /** 편집기 닫기 */
    function closePresetEditor() {
      _editingPresetId = null;
      _presetItems = [];
      document.getElementById('preset-editor-empty').style.display = '';
      document.getElementById('preset-editor-form').style.display = 'none';
      document.getElementById('preset-preview-section').style.display = 'none';
      loadPresets();
    }

    /** 모든 플랫폼의 모니터링 대상을 병렬로 조회해 블록으로 렌더링 */
    async function loadAvailableBlocks() {
      const $area = document.getElementById('preset-available-blocks');
      $area.innerHTML = '<span style="font-size:12px;color:#94a3b8">불러오는 중...</span>';
      try {
        const [guildsData, igData, fbData, nlData] = await Promise.allSettled([
          apiFetch(`/guilds?workspaceId=${WS}`),
          apiFetch(`/instagram/accounts?workspaceId=${WS}`),
          apiFetch(`/facebook/groups?workspaceId=${WS}`),
          apiFetch(`/naver/lounges?workspaceId=${WS}`),
        ]);

        const allTargets = [];

        if (guildsData.status === 'fulfilled') {
          (guildsData.value.guilds || []).forEach((g) => allTargets.push({
            platform: 'discord',
            targetId: g.docId,
            targetName: g.guildName || g.docId,
          }));
        }
        if (igData.status === 'fulfilled') {
          (igData.value.accounts || []).forEach((a) => allTargets.push({
            platform: 'instagram',
            targetId: a.igUserId,
            targetName: '@' + (a.username || a.igUserId),
          }));
        }
        if (fbData.status === 'fulfilled') {
          (fbData.value.groups || []).forEach((g) => allTargets.push({
            platform: 'facebook',
            targetId: g.docId,
            targetName: g.groupName || g.docId,
          }));
        }
        if (nlData.status === 'fulfilled') {
          (nlData.value.lounges || []).forEach((l) => allTargets.push({
            platform: 'naver_lounge',
            targetId: l.docId,
            targetName: l.loungeName || l.docId,
          }));
        }

        if (!allTargets.length) {
          $area.innerHTML = '<span style="font-size:12px;color:#94a3b8">등록된 모니터링 대상이 없습니다</span>';
          return;
        }

        $area.innerHTML = allTargets.map((t) => {
          const meta = PRESET_PLATFORM_META[t.platform] || { icon: '📋', cls: '', label: t.platform };
          const payload = JSON.stringify(t).replace(/"/g, '&quot;');
          return `<span class="preset-block ${meta.cls}"
                        draggable="true"
                        ondragstart="onPresetBlockDragStart(event, ${payload})">
                    ${meta.icon} ${escapeHtml(t.targetName)}
                  </span>`;
        }).join('');
      } catch (err) {
        $area.innerHTML = `<span style="font-size:12px;color:var(--neg)">조회 실패</span>`;
      }
    }

    /** 드롭존 렌더링 */
    function renderDropZone() {
      const $zone = document.getElementById('preset-dropzone');
      const $hint = document.getElementById('preset-dropzone-hint');
      if (!_presetItems.length) {
        $hint.style.display = '';
        $zone.querySelectorAll('.preset-block--placed').forEach((el) => el.remove());
        return;
      }
      $hint.style.display = 'none';
      // 기존 placed 블록 제거 후 재렌더
      $zone.querySelectorAll('.preset-block--placed').forEach((el) => el.remove());
      _presetItems.forEach((item, idx) => {
        const meta = PRESET_PLATFORM_META[item.platform] || { icon: '📋', cls: '' };
        const el = document.createElement('span');
        el.className = `preset-block--placed ${meta.cls}`;
        el.innerHTML = `${meta.icon} ${escapeHtml(item.targetName)}
          <button class="preset-block-remove" onclick="removePresetItem(${idx})" title="제거">✕</button>`;
        $zone.appendChild(el);
      });
      updateEmailPreview();
    }

    // ── 이메일 미리보기 ──────────────────────────────────────────

    function _previewEsc(str) {
      return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function _buildPreviewDiscordSection(report) {
      const issues = (report.issues || []).slice(0, 3);
      const issueRows = issues.map((iss) => `
        <div class="iss">
          <div class="iss-t">${_previewEsc(iss.title)}</div>
          <div class="iss-d">${_previewEsc(iss.description)}</div>
        </div>`).join('');
      return `
        <div><span class="dc-bdg">${report.messageCount || 0}개 메시지</span></div>
        <div class="dc-sum">${_previewEsc(report.summary)}</div>
        ${issueRows ? `<div><div class="dc-ish">🚨 주요 이슈</div>${issueRows}</div>` : ''}`;
    }

    function _buildPreviewInstagramSection(report) {
      const posts = (report.posts || []).slice(0, 3);
      const postRows = posts.map((p) => {
        const cap = _previewEsc((p.caption || '').slice(0, 20) + ((p.caption||'').length > 20 ? '…' : ''));
        return `<tr>
          <td class="ig-tdd">—</td>
          <td class="ig-tdc">${cap}</td>
          <td class="ig-tdt">—</td>
          <td class="ig-tdr">—</td><td class="ig-tdr">—</td><td class="ig-tdr">—</td>
          <td class="ig-tdr">—</td><td class="ig-tdr">—</td><td class="ig-tdr">—</td>
          <td class="ig-tdr">—</td>
        </tr>`;
      }).join('');
      return `
        <div class="ig-ptw">
          <div class="ig-h">최근 1주 포스트</div>
          <div class="ig-scroll">
            <table class="ig-tbl">
              <thead><tr class="ig-thead-tr">
                <th class="ig-th">날짜</th><th class="ig-th">본문</th><th class="ig-th">유형</th>
                <th class="ig-th-r">조회</th><th class="ig-th-r">좋아요</th><th class="ig-th-r">댓글</th>
                <th class="ig-th-r">공유</th><th class="ig-th-r">저장</th><th class="ig-th-r">프로필방문</th>
                <th class="ig-th-r">참여율</th>
              </tr></thead>
              <tbody>${postRows}</tbody>
            </table>
          </div>
        </div>
        ${report.aiPerformanceReview ? `<div class="ig-rev"><div class="ig-rev-in"><span class="ig-rev-t">AI 성과 리뷰</span><div class="ig-rev-b">${_previewEsc(report.aiPerformanceReview)}</div></div></div>` : ''}`;
    }

    function _buildPreviewCrawlerSection(report, accentColor) {
      const issues = (report.aiIssues || []).slice(0, 3);
      const issueRows = issues.map((iss) => `
        <div class="cr-iss">
          <div class="cr-iss-t">${_previewEsc(iss.title)}</div>
          <div class="cr-iss-d">${_previewEsc(iss.description)}</div>
        </div>`).join('');
      return `
        <div><span class="cr-bdg">${report.postCount || 0}개 게시글</span></div>
        ${report.aiSummary ? `<div class="cr-sum" style="border-left:3px solid ${accentColor}">${report.aiSummary}</div>` : ''}
        ${issueRows ? `<div><div class="cr-ish">🚨 주요 이슈</div>${issueRows}</div>` : ''}`;
    }

    function buildEmailPreviewHTML(presetName, items) {
      const today = new Date().toLocaleDateString('ko-KR', { year:'numeric', month:'long', day:'numeric' });

      const sectionHtmls = items.map(({ platform, targetName }, idx) => {
        const meta = PRESET_PLATFORM_META[platform] || { label: platform, color: '#6366f1', emailIcon: '📋' };
        const mock = PREVIEW_MOCK[platform] || {};
        let bodyHtml = '';
        if (platform === 'discord')           bodyHtml = _buildPreviewDiscordSection(mock);
        else if (platform === 'instagram')    bodyHtml = _buildPreviewInstagramSection(mock);
        else if (platform === 'facebook')     bodyHtml = _buildPreviewCrawlerSection(mock, meta.color);
        else if (platform === 'naver_lounge') bodyHtml = _buildPreviewCrawlerSection(mock, meta.color);
        const divider = idx > 0 ? `<div class="sec-div"></div>` : '';
        return `
          ${divider}
          <div class="sec">
            <div class="sec-hd">
              <span style="display:inline-block;width:4px;height:20px;background:${meta.color};border-radius:2px"></span>
              <span style="font-size:11px;font-weight:700;color:${meta.color};letter-spacing:.05em;text-transform:uppercase">${meta.emailIcon} ${meta.label}</span>
              <span class="sec-nm">${_previewEsc(targetName)}</span>
            </div>
            ${bodyHtml}
          </div>`;
      }).join('');

      const indexBadges = items.map(({ platform, targetName }) => {
        const meta = PRESET_PLATFORM_META[platform] || { label: platform, color: '#6366f1', emailIcon: '📋' };
        return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${meta.color}1a;color:${meta.color};font-size:11px;font-weight:600">${meta.emailIcon} ${_previewEsc(targetName)}</span>`;
      }).join('');

      return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
        <style>
          body{margin:0;padding:0;background:#f8fafc;font-family:-apple-system,'Malgun Gothic','맑은 고딕',sans-serif}
          .wrap{max-width:640px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
          .hero{background:linear-gradient(135deg,#f58529 0%,#dd2a7b 50%,#8134af 100%);padding:28px 32px}
          .hero-sub{color:rgba(255,255,255,.75);font-size:11px;letter-spacing:.08em;margin-bottom:6px}
          .hero-title{color:#fff;font-size:22px;font-weight:700}
          .hero-date{color:rgba(255,255,255,.8);font-size:14px;margin-top:4px}
          .toc{padding:18px 32px 0;border-bottom:1px solid #f1f5f9}
          .toc-chips{display:flex;flex-wrap:wrap;gap:6px;padding-bottom:18px}
          .secs{padding-top:28px}
          .sec-div{border-top:2px dashed #e2e8f0;margin:0 32px 28px}
          .sec{padding:0 32px 28px}
          .sec-hd{display:flex;align-items:center;gap:8px;margin-bottom:14px}
          .sec-nm{font-size:13px;font-weight:600;color:#1e293b}
          .ft{background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center}
          .dc-bdg{display:inline-block;background:#5865f21a;color:#5865f2;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;margin-bottom:10px}
          .dc-sum{font-size:13px;color:#374151;line-height:1.7;background:#f8fafc;border-left:3px solid #5865f2;border-radius:0 8px 8px 0;padding:12px 14px;margin-bottom:12px}
          .dc-ish{font-size:11px;font-weight:700;color:#64748b;margin-bottom:8px}
          .iss{padding:10px 12px;background:#ede9fe;border-left:3px solid #6366f1;border-radius:0 8px 8px 0;margin-bottom:6px}
          .iss-t{font-size:13px;font-weight:600;color:#4338ca}
          .iss-d{font-size:12px;color:#4c1d95;margin-top:2px}
          .ig-h{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6366f1;margin-bottom:10px}
          .ig-ptw{margin-bottom:24px}
          .ig-scroll{overflow-x:auto}
          .ig-tbl{width:100%;border-collapse:collapse;font-size:11px;min-width:680px}
          .ig-thead-tr{background:#f8fafc}
          .ig-th{padding:6px;text-align:left;color:#475569;font-weight:600}
          .ig-th-r{padding:6px;text-align:right;color:#475569;font-weight:600}
          .ig-tdd{padding:6px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b;white-space:nowrap}
          .ig-tdc{padding:6px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#334155;width:96px;max-width:96px;line-height:1.35;word-break:break-word}
          .ig-tdt{padding:6px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b}
          .ig-tdr{padding:6px;border-bottom:1px solid #f1f5f9;font-size:11px;text-align:right}
          .ig-rev{margin-bottom:24px}
          .ig-rev-in{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px}
          .ig-rev-t{font-size:11px;font-weight:700;color:#475569;display:block;margin-bottom:8px}
          .ig-rev-b{font-size:13px;color:#374151;line-height:1.6}
          .cr-bdg{display:inline-block;background:#f0fdf4;color:#166534;font-size:11px;font-weight:600;padding:3px 8px;border-radius:999px;margin-bottom:10px}
          .cr-sum{font-size:13px;color:#374151;line-height:1.8;padding:14px 16px;background:#f8fafc;border-radius:10px;margin-bottom:12px}
          .cr-ish{font-size:11px;font-weight:700;color:#64748b;margin-bottom:6px}
          .cr-iss{padding:10px 12px;background:#fff7ed;border-left:3px solid #f97316;border-radius:0 8px 8px 0;margin-bottom:6px}
          .cr-iss-t{font-size:12px;font-weight:600;color:#c2410c}
          .cr-iss-d{font-size:11px;color:#78350f;margin-top:2px}
        </style>
        </head><body>
        <div class="wrap">
          <div class="hero">
            <div class="hero-sub">AI SOCIAL LISTENING · INTEGRATED REPORT</div>
            <div class="hero-title">${_previewEsc(presetName)}</div>
            <div class="hero-date">${today}</div>
          </div>
          <div class="toc"><div class="toc-chips">${indexBadges}</div></div>
          <div class="secs">${sectionHtmls}</div>
          <div class="ft">Social Listener by 사업전략팀 &nbsp;·&nbsp; 이 메일은 자동 발송됩니다</div>
        </div>
      </body></html>`;
    }

    function updateEmailPreview() {
      const section = document.getElementById('preset-preview-section');
      const frame   = document.getElementById('preset-preview-frame');
      if (!section || !frame) return;
      if (!_presetItems.length) { section.style.display = 'none'; return; }
      section.style.display = '';
      const presetName = (document.getElementById('preset-name-input')?.value || '').trim() || '(이름 미입력)';
      frame.srcdoc = buildEmailPreviewHTML(presetName, _presetItems);
    }

    /** 드래그 시작: dataTransfer에 블록 정보 저장 */
    function onPresetBlockDragStart(event, item) {
      event.dataTransfer.setData('application/json', JSON.stringify(item));
      event.dataTransfer.effectAllowed = 'copy';
    }

    /** 드롭: 블록을 프리셋 구성에 추가 */
    function onPresetDrop(event) {
      event.preventDefault();
      event.currentTarget.classList.remove('preset-dropzone--over');
      let item;
      try { item = JSON.parse(event.dataTransfer.getData('application/json')); } catch { return; }
      // 중복 추가 방지
      if (_presetItems.some((i) => i.platform === item.platform && i.targetId === item.targetId)) return;
      _presetItems.push(item);
      renderDropZone();
    }

    /** 드롭존에서 항목 제거 */
    function removePresetItem(idx) {
      _presetItems.splice(idx, 1);
      renderDropZone();
    }

    /** 프리셋 저장 (신규 또는 수정) */
    async function savePreset() {
      const name = document.getElementById('preset-name-input').value.trim();
      if (!name) { alert('프리셋 이름을 입력하세요'); return; }
      const recipients = _presetChipInput ? _presetChipInput.getEmails() : [];
      const body = { workspaceId: WS, name, items: _presetItems, recipients };

      try {
        if (_editingPresetId) {
          await apiFetch('/report-presets', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, presetId: _editingPresetId }),
          });
        } else {
          await apiFetch('/report-presets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        }
        closePresetEditor();
      } catch (err) {
        alert('저장 실패: ' + err.message);
      }
    }

    /** 프리셋 삭제 */
    async function deletePreset(presetId) {
      const ok = await confirmDialog('이 프리셋을 삭제하시겠습니까?');
      if (!ok) return;
      try {
        await apiFetch('/report-presets', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, presetId }),
        });
        if (_editingPresetId === presetId) closePresetEditor();
        else loadPresets();
      } catch (err) {
        alert('삭제 실패: ' + err.message);
      }
    }

    /** 통합 이메일 수동 트리거 (이메일 발송 주의) */
    async function triggerPresetEmail(date) {
      const confirmed = await showConfirm({
        platform: 'discord',
        icon: '📋',
        title: '통합 프리셋 이메일 발송',
        sub: date || '오늘 기준 어제',
        desc: '활성화된 모든 프리셋의 통합 이메일을 수신자에게 발송합니다. 계속하시겠습니까?',
        confirmLabel: '발송',
        color: '#6366f1',
      });
      if (!confirmed) return;
      try {
        await apiFetch('/report-presets/email/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, date: date || null }),
        });
        alert('발송 완료');
      } catch (err) {
        alert('발송 실패: ' + err.message);
      }
    }

