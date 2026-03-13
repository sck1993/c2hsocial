    /* ── Config ── */
    const API = 'https://api-xsauyjh24q-du.a.run.app';
    const WS = 'ws_antigravity';
    let _igPendingAccountSelection = null;
    const IG_PERFORMANCE_MODELS = [
      { value: 'openai/gpt-5-mini', label: 'GPT-5 mini (medium)' },
      { value: 'google/gemini-3-flash-preview', label: 'Gemini Flash 3' },
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
    let _fpIgDatePicker = null;
    let _availableDailyDates = [], _availableWeeklyDates = [], _availableIgDates = [];
    let _selectedWeekMonday = null; // 주간 picker: 선택된 주의 월요일

    async function initAvailableDates() {
      try {
        const [daily, weekly, ig] = await Promise.all([
          apiFetch(`/available-dates?workspaceId=${WS}&type=daily`),
          apiFetch(`/available-dates?workspaceId=${WS}&type=weekly`),
          apiFetch(`/instagram/available-dates?workspaceId=${WS}`),
        ]);
        _availableDailyDates  = daily.dates  || [];
        _availableWeeklyDates = weekly.dates || [];
        _availableIgDates     = ig.dates     || [];
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
    }

    /* ── View switching ── */
    let currentView = 'landing';
    let _reportLang = 'ko'; // 'ko' | 'en'

    /* ── Guild filter cache ── */
    let _reportAllGuilds = [];
    let _weeklyAllGuilds = [];
    let _alertAllChannels = [];

    function switchView(view) {
      currentView = view;

      // Sub-nav active state
      document.getElementById('nav-report').classList.toggle('active', view === 'report');
      document.getElementById('nav-weekly').classList.toggle('active', view === 'weekly');
      document.getElementById('nav-analytics').classList.toggle('active', view === 'analytics');
      document.getElementById('nav-channels').classList.toggle('active', view === 'channels');
      document.getElementById('nav-data').classList.toggle('active', view === 'data');
      document.getElementById('nav-alert').classList.toggle('active', view === 'alert');
      document.getElementById('nav-ig-report').classList.toggle('active', view === 'ig-report');
      document.getElementById('nav-ig-accounts').classList.toggle('active', view === 'ig-accounts');
      document.getElementById('nav-ig-tokens').classList.toggle('active', view === 'ig-tokens');

      // Topbars
      document.getElementById('topbar-report').classList.toggle('hidden', view !== 'report');
      document.getElementById('topbar-weekly').classList.toggle('hidden', view !== 'weekly');
      document.getElementById('topbar-analytics').classList.toggle('hidden', view !== 'analytics');
      document.getElementById('topbar-channels').classList.toggle('hidden', view !== 'channels');
      document.getElementById('topbar-data').classList.toggle('hidden', view !== 'data');
      document.getElementById('topbar-alert').classList.toggle('hidden', view !== 'alert');
      document.getElementById('topbar-ig-report').classList.toggle('hidden', view !== 'ig-report');
      document.getElementById('topbar-ig-accounts').classList.toggle('hidden', view !== 'ig-accounts');
      document.getElementById('topbar-ig-tokens').classList.toggle('hidden', view !== 'ig-tokens');

      // Views
      document.getElementById('view-landing').classList.toggle('hidden', view !== 'landing');
      document.getElementById('view-report').classList.toggle('hidden', view !== 'report');
      document.getElementById('view-weekly').classList.toggle('hidden', view !== 'weekly');
      document.getElementById('view-analytics').classList.toggle('hidden', view !== 'analytics');
      document.getElementById('view-channels').classList.toggle('hidden', view !== 'channels');
      document.getElementById('view-data').classList.toggle('hidden', view !== 'data');
      document.getElementById('view-alert').classList.toggle('hidden', view !== 'alert');
      document.getElementById('view-ig-report').classList.toggle('hidden', view !== 'ig-report');
      document.getElementById('view-ig-accounts').classList.toggle('hidden', view !== 'ig-accounts');
      document.getElementById('view-ig-tokens').classList.toggle('hidden', view !== 'ig-tokens');

      if (view === 'report') loadReport();
      if (view === 'channels') loadChannels();
      if (view === 'data') loadDataLogs();
      if (view === 'alert') loadAlertMonitor();
      if (view === 'ig-report') { refreshIgAvailableDates(); loadIgReport(); }
      if (view === 'ig-accounts') loadIgAccounts();
      if (view === 'ig-tokens') loadIgTokens();
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
      $list.innerHTML = `<div class="sk" style="height:72px;border-radius:12px;margin-bottom:.75rem"></div>`.repeat(3);

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
        `<div class="sk" style="height:108px;border-radius:12px;margin-bottom:1.75rem"></div>` +
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
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
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
        <div class="sk" style="height:170px;border-radius:12px"></div>
        <div class="sk" style="height:170px;border-radius:12px"></div>
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
        <p class="summary-body">${formatSummary(summaryText)}</p>
      </div>

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
          : `<span style="color:var(--text-3);font-size:.875rem">${L.noKeywords}</span>`}
          </div>
        </div>
      </div>

      ${issues.length ? `
      <div class="scard anim d5" style="margin-top:1rem">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.warn}${L.issuesSectionLabel} <span style="color:var(--text-3);margin-left:.25rem;font-weight:400;letter-spacing:0">${issues.length}${isEN ? '' : '건'}</span></div>
        <div class="issues-list">
          ${issues.map(iss => {
            const sev = severity(iss.count);
            const chLabel = iss.channel ? `<span style="color:var(--accent);font-size:.75rem;margin-left:.375rem">#${iss.channel}</span>` : '';
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
      <div class="scard anim d5 guild-report-channels" style="margin-top:1rem">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.msg}${L.channelsSectionLabel} <span style="color:var(--text-3);margin-left:.25rem;font-weight:400;letter-spacing:0">${channels.length}${isEN ? '' : '개'}</span></div>
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
          : `<span style="color:var(--text-3);font-size:.875rem">키워드 없음</span>`}
          </div>
        </div>
      </div>

      ${issues.length ? `
      <div class="scard anim d5" style="margin-top:1rem">
        <div class="slabel"><div class="slabel-dot"></div>${SVG.warn}주요 이슈 <span style="color:var(--text-3);margin-left:.25rem;font-weight:400;letter-spacing:0">${issues.length}건</span></div>
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
          <div class="slabel"><div class="slabel-dot"></div>🚨 ${L.weeklyIssues} <span style="color:var(--text-3);margin-left:.25rem;font-weight:400;letter-spacing:0">${(g.weeklyIssues || []).length}${isEN ? '' : '건'}</span></div>
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
          <div class="scard" style="margin-bottom:16px">
            <div class="slabel"><div class="slabel-dot"></div>📡 ${L.insights} (${g.weekStart} ~ ${g.weekEnd})</div>
            <canvas id="insightChart_${safeId}" height="80"></canvas>
          </div>
          <div class="scard" style="margin-bottom:16px">
            <div class="slabel"><div class="slabel-dot"></div>💬 ${L.sentimentTrend}</div>
            <canvas id="sentimentChart_${safeId}" height="80"></canvas>
          </div>
          <div class="scard" style="margin-bottom:16px">
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
          <div class="scard" style="margin-bottom:16px">
            <div class="slabel"><div class="slabel-dot"></div>📡 서버 인사이트 (${startDate} ~ ${endDate})</div>
            <canvas id="aInsightChart_${safeId}" height="80"></canvas>
            ${buildInsightTable(safeId, g.insightsChart || [])}
          </div>
          <div class="scard" style="margin-bottom:16px">
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

    function showConfirm({ platform = 'discord', icon = '', title = '', badge = '', sub = '', desc = '', confirmLabel = '실행', color = '#6366f1' }) {
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
          <div class="panel-desc">Instagram Business/Creator 계정의 Long-lived Access Token을 입력합니다.</div>
          <div class="info-banner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>토큰 발급: Meta 개발자 콘솔 → 앱 → 그래프 API 탐색기 → User Token 생성 (instagram_basic, instagram_manage_insights, pages_show_list 권한 포함) → 장기 토큰(EAAxxxx)으로 교환</span>
          </div>
          <div class="field-group">
            <label class="field-label">Meta 앱 ID <span style="color:var(--neg)">*</span></label>
            <input class="field-input" id="igAppIdInput" type="text" placeholder="1234567890" autocomplete="off">
          </div>
          <div class="field-group">
            <label class="field-label">Meta 앱 시크릿 <span style="color:var(--neg)">*</span></label>
            <input class="field-input" id="igAppSecretInput" type="password" placeholder="앱 시크릿 코드" autocomplete="off">
          </div>
          <div class="field-group">
            <label class="field-label">Long-lived Access Token <span style="color:var(--neg)">*</span></label>
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
          <div id="igAccountList"><div class="sk" style="height:72px;border-radius:12px;margin-bottom:.75rem"></div></div>
        </div>
      </div>`;

      try {
        const { accounts } = await apiFetch(`/instagram/accounts?workspaceId=${WS}`);
        document.getElementById('igListCount').textContent = accounts.length;
        const $list = document.getElementById('igAccountList');
        if (!accounts.length) {
          $list.innerHTML = `<div class="ch-empty"><div style="text-align:center;color:var(--text-muted)">등록된 계정 없음</div></div>`;
        } else {
          $list.innerHTML = accounts.map(igAccountRowHTML).join('');
        }
      } catch (err) {
        document.getElementById('igAccountList').innerHTML = `<div class="state-wrap"><div class="state-title">불러오기 실패</div><div class="state-desc">${escapeHtml(err.message)}</div></div>`;
      }
    }

    function igAccountRowHTML(acc) {
      const isActive = acc.isActive !== false;
      const panelId = `ig-settings-${acc.docId}`;
      const recipients = (acc.deliveryConfig?.email?.recipients || []).join(', ');
      const emailEnabled = acc.deliveryConfig?.email?.isEnabled || false;
      const selectedModel = IG_PERFORMANCE_MODELS.some(m => m.value === acc.performanceReviewModel)
        ? acc.performanceReviewModel
        : IG_PERFORMANCE_MODELS[0].value;

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
          <div class="ch-row-meta">Instagram Business</div>
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
          <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;cursor:pointer">
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
      </div>`;
    }

    function toggleIgSettings(docId) {
      const panel = document.getElementById(`ig-settings-${docId}`);
      const btn = document.getElementById(`igSettingsBtn-${docId}`);
      const open = panel.classList.toggle('open');
      btn.classList.toggle('active', open);
    }

    async function addIgAccount() {
      const appId     = document.getElementById('igAppIdInput').value.trim();
      const appSecret = document.getElementById('igAppSecretInput').value.trim();
      const token     = document.getElementById('igTokenInput').value.trim();
      const $picker = document.getElementById('igCandidatePicker');
      const $result = document.getElementById('igAddResult');
      const $btn = document.getElementById('igAddBtn');
      if (!appId)     { $result.className = 'add-result err'; $result.textContent = '앱 ID를 입력해 주세요.'; return; }
      if (!appSecret) { $result.className = 'add-result err'; $result.textContent = '앱 시크릿을 입력해 주세요.'; return; }
      if (!token)     { $result.className = 'add-result err'; $result.textContent = '액세스 토큰을 입력해 주세요.'; return; }
      _igPendingAccountSelection = null;
      if ($picker) $picker.innerHTML = '';
      $btn.disabled = true;
      $btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin .75s linear infinite"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 검증 중...`;
      $result.className = 'add-result'; $result.textContent = '';
      try {
        const res = await apiFetch('/instagram/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS, accessToken: token, appId, appSecret }),
        });
        if (res.requiresSelection && Array.isArray(res.candidates) && res.candidates.length) {
          _igPendingAccountSelection = { appId, appSecret, token, candidates: res.candidates };
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
        $result.textContent = err.message;
      } finally {
        $btn.disabled = false;
        $btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> 계정 추가`;
      }
    }

    function renderIgCandidatePicker(candidates) {
      return `
        <div class="info-banner" style="margin-top:1rem;display:block">
          <div style="font-weight:600;margin-bottom:.5rem">연결된 Instagram 계정 선택</div>
          <div style="display:flex;flex-direction:column;gap:.5rem">
            ${candidates.map((candidate) => `
              <button type="button"
                class="btn-save-settings"
                style="text-align:left;display:flex;justify-content:space-between;align-items:center;padding:.75rem 1rem"
                onclick="confirmIgAccountSelection('${escapeHtml(candidate.igUserId)}')">
                <span>@${escapeHtml(candidate.username || candidate.igUserId)}</span>
                <span style="font-size:.75rem;color:var(--text-3)">${escapeHtml(candidate.pageName || candidate.pageId || '')}</span>
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
        $result.textContent = err.message;
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
        confirmLabel: '실행',
      });
      if (!ok) return;

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
          body: JSON.stringify({ workspaceId: WS, date }),
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
        renderIgReportView(date, r);
      } catch (err) {
        handleApiError(err, $main);
      }
    }

    function renderIgReportView(date, data) {
      const $main = document.getElementById('ig-report-main');
      const accounts = data.accounts || [];
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

    function initIgTrendChart(acc) {
      const canvasId = `ig-trend-${escapeHtml(String(acc.igUserId || acc.username))}`;
      const ctx = document.getElementById(canvasId);
      if (!ctx || !acc.trendData || !acc.trendData.length) return;
      new Chart(ctx, {
        data: {
          labels: acc.trendData.map(d => d.date ? d.date.slice(5).replace('-', '/') : ''),
          datasets: [
            {
              type: 'bar',
              label: '오가닉 조회',
              data: acc.trendData.map(d => d.dailyViews == null ? null : Math.round(Number(d.dailyViews))),
              yAxisID: 'y',
              backgroundColor: 'rgba(99,102,241,0.3)',
              borderColor: '#6366f1',
              borderWidth: 1,
            },
            {
              type: 'line',
              label: '팔로워',
              data: acc.trendData.map(d => d.followerCount == null ? null : Math.round(Number(d.followerCount))),
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

    const SVG_IG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`;
    const SVG_USERS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
    const SVG_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const SVG_HEART = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
    const SVG_GRID = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`;
    const SVG_TRENDING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`;
    const SVG_AWARD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>`;

    function igAccountReportHTML(acc) {
      const posts = acc.posts || [];
      const MEDIA_LABELS = { IMAGE: '사진', VIDEO: '영상', REELS: '영상', CAROUSEL_ALBUM: '슬라이드' };

      const perfBlock = acc.aiPerformanceReview
        ? (() => {
            const lines = acc.aiPerformanceReview.split('\n').filter(l => l.trim());
            const linesHtml = lines.map(l => `<div style="margin-bottom:4px">${sanitizeReportHtml(l)}</div>`).join('');
            return `<div class="scard anim d5">
              <div class="slabel"><div class="slabel-dot"></div>${SVG_GRID}AI 성과 리뷰 <span style="color:var(--text-3);margin-left:.25rem;font-weight:400;letter-spacing:0">최근 2주 포스트 종합</span></div>
              <div style="font-size:.8125rem;color:var(--text);line-height:1.6">${linesHtml}</div>
            </div>`;
          })()
        : '';

      return `
      <div class="ch-header anim d1">
        <div class="ch-platform-icon" style="color:#E1306C">${SVG_IG}</div>
        <div>
          <div class="ch-name">@${escapeHtml(acc.username || acc.igUserId)}</div>
          <div class="ch-id">Instagram &middot; 최근 14일 포스트 ${posts.length}개</div>
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
        <div class="slabel"><div class="slabel-dot"></div>${SVG_GRID}최근 게시물 <span style="color:var(--text-3);margin-left:.25rem;font-weight:400;letter-spacing:0">${posts.length}건</span></div>
        ${igPostTableHTML(posts)}
      </div>

      ${perfBlock}

      ${(acc.model || acc.totalTokens) ? `
      <div class="token-info-strip anim d6">
        ${acc.model ? `<span class="token-model">${escapeHtml(acc.model)}</span>` : ''}
        ${acc.totalTokens ? `<span>입력 ${(acc.promptTokens || 0).toLocaleString()} / 출력 ${(acc.completionTokens || 0).toLocaleString()} / 합계 ${(acc.totalTokens || 0).toLocaleString()} 토큰</span>` : ''}
        ${acc.cost != null ? `<span>비용 $${Number(acc.cost).toFixed(4)}</span>` : ''}
      </div>` : ''}`;
    }

    function igPostTableHTML(posts) {
      if (!posts || !posts.length) return '<div style="color:var(--text-2);font-size:.875rem;padding:.5rem 0">포스트 없음</div>';
      const MEDIA_LABELS = { IMAGE: '사진', VIDEO: '영상', REELS: '영상', CAROUSEL_ALBUM: '슬라이드' };
      const DOW_KO = ['일','월','화','수','목','금','토'];
      const rows = posts.map(p => {
        const er = p.engagementRate ?? 0;
        const erColor = er >= 5 ? '#059669' : er >= 2 ? '#d97706' : '#94a3b8';

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

        const mtRaw = (p.mediaType || p.media_type || '').toUpperCase();
        const mt = mtRaw === 'REELS' ? 'VIDEO' : mtRaw;
        const typeLabel = MEDIA_LABELS[mt] || escapeHtml(mt || '-');

        // 조회: 실제 views API값, fallback reach
        const views = p.views != null ? p.views.toLocaleString() : (p.reach != null ? p.reach.toLocaleString() : '-');

        // 팔로우: FEED(IMAGE, CAROUSEL_ALBUM) 전용 — VIDEO/STORY는 API 400 확인
        const follows = (mt === 'IMAGE' || mt === 'CAROUSEL_ALBUM')
          ? (p.follows != null ? p.follows.toLocaleString() : '-')
          : '—';

        const wt = p.reelAvgWatchTime != null ? `${(p.reelAvgWatchTime / 1000).toFixed(1)}초` : '—';

        return `<tr>
          <td style="white-space:nowrap">${dateStr}</td>
          <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.75rem" title="${p.caption ? escapeHtml(p.caption) : ''}">${captionCell}</td>
          <td><span style="font-size:.6875rem;padding:2px 5px;border-radius:4px;background:var(--surface-2);color:var(--text-2)">${typeLabel}</span></td>
          <td>${views}</td>
          <td>${p.likes != null ? p.likes.toLocaleString() : '-'}</td>
          <td>${p.comments != null ? p.comments.toLocaleString() : '-'}</td>
          <td>${p.shares != null ? p.shares.toLocaleString() : '-'}</td>
          <td>${p.saves != null ? p.saves.toLocaleString() : '-'}</td>
          <td>${p.profileVisits != null ? p.profileVisits.toLocaleString() : '-'}</td>
          <td>${follows}</td>
          <td style="color:#6366f1">${wt}</td>
          <td style="color:${erColor};font-weight:600">${er}%</td>
        </tr>`;
      }).join('');
      return `<div style="overflow-x:auto;margin-top:.75rem">
        <table class="data-table" style="font-size:.75rem">
          <thead><tr>
            <th>날짜</th><th>본문</th><th>유형</th><th>조회</th>
            <th>좋아요</th><th>댓글</th><th>공유</th><th>저장</th>
            <th>프로필</th><th>팔로우</th><th style="color:#6366f1">평균시청</th><th>참여율</th>
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
      return `<tr>
        <td>@${escapeHtml(acc.username || acc.igUserId || '')}</td>
        <td><span style="color:${s.color};font-weight:600">${s.text}</span></td>
        <td>${expiresStr}</td>
        <td>${daysStr}</td>
        <td>${refreshedStr}</td>
        <td><button class="btn-save-settings" style="padding:.25rem .75rem;font-size:.8125rem" data-docid="${escapeHtml(acc.docId)}" onclick="refreshIgToken(this.dataset.docid)">갱신</button></td>
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

