"use strict";

const { Resvg } = require("@resvg/resvg-js");
const { dispatchEmail } = require("./reportEmailCore");

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeCaptionText(text) {
  if (!text) return "";
  return String(text)
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\uFFFD+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeReportHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html.replace(/<(?!\/?(?:br|strong)\b)[^>]*>/gi, "");
}

function formatReviewText(text) {
  if (!text) return "";
  const escaped = escapeHtml(text);
  const withBold = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return sanitizeReportHtml(withBold);
}

function formatReviewLine(line) {
  const trimmed = String(line || "").trim();
  const labelSpecs = [
    { prefix: "✅ 잘된 점", text: "잘된 점", badgeBg: "#dcfce7", badgeColor: "#166534", bodyColor: "#166534" },
    { prefix: "⚠️ 아쉬운 점", text: "아쉬운 점", badgeBg: "#fef3c7", badgeColor: "#92400e", bodyColor: "#7c2d12" },
    { prefix: "💡 개선 제안", text: "개선 제안", badgeBg: "#dbeafe", badgeColor: "#1d4ed8", bodyColor: "#1e3a8a" },
    { prefix: "✅ What Worked", text: "What Worked", badgeBg: "#dcfce7", badgeColor: "#166534", bodyColor: "#166534" },
    { prefix: "⚠️ What Fell Short", text: "What Fell Short", badgeBg: "#fef3c7", badgeColor: "#92400e", bodyColor: "#7c2d12" },
    { prefix: "💡 Recommendations", text: "Recommendations", badgeBg: "#dbeafe", badgeColor: "#1d4ed8", bodyColor: "#1e3a8a" },
  ];

  const matched = labelSpecs.find((spec) => trimmed.startsWith(spec.prefix));
  if (!matched) {
    return `<div style="margin-bottom:10px;font-size:13px;color:#374151;line-height:1.7">${formatReviewText(trimmed)}</div>`;
  }

  const content = trimmed.slice(matched.prefix.length).trim().replace(/^[:：-]\s*/, "");
  return `
    <div style="margin-bottom:12px;padding:12px 13px;border:1px solid #e2e8f0;border-radius:10px;background:#ffffff">
      <span style="display:inline-block;padding:3px 8px;border-radius:999px;background:${matched.badgeBg};color:${matched.badgeColor};font-size:11px;font-weight:700;margin-bottom:7px">${matched.text}</span>
      <div style="font-size:13px;color:${matched.bodyColor};line-height:1.7">${formatReviewText(content)}</div>
    </div>`;
}

function formatSummaryHtml(text) {
  if (!text) return "—";
  if (text.includes("<br>") || text.includes("<strong>")) return text;
  return text
    .replace(/\[([^\]]+)\]/g, (_, label) => `<br><br><strong>[${label}]</strong>`)
    .replace(/^<br><br>/, "");
}

function toChartNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function computeChartScale(values, { minVisualRange = 1, paddingRatio = 0.12 } = {}) {
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const rawRange = maxValue - minValue;
  const paddedRange = Math.max(rawRange, minVisualRange);
  const padding = Math.max(1, Math.round(paddedRange * paddingRatio));
  return {
    min: minValue - padding,
    max: maxValue + padding,
  };
}

function formatAxisNumber(value) {
  if (value == null || !Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString();
}

function formatKSTDate(dateStr) {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const [year, month, day] = String(dateStr || "").split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 3, 0, 0));
  return `${year}년 ${month}월 ${day}일 (${days[d.getUTCDay()]})`;
}

function formatENDate(dateStr) {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const [year, month, day] = String(dateStr || "").split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 3, 0, 0));
  return `${days[d.getUTCDay()]}, ${months[month - 1]} ${day}, ${year}`;
}

const IG_CHART_LABEL_IMAGES = {
  organicViewsLegend: "iVBORw0KGgoAAAANSUhEUgAAALQAAAAmCAYAAABtY7F6AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMDSURBVHhe7ZnBjdswEEW3gDSQBtJACsgCseWb7Rxy2w62A7eQFlyDm3AXPgVYykCqSDCSKA2/SIqiLESC/wMG2PWIlDR8pkj55YUQQgghhBBCCCGEEEIIeXL2W/N+KMq/Epibiu1XzoG5pWGv9VCYC+YsulbH4v4V86Th57c/n/Ybs98X5twVtpGhMGfJYZtHkSp0jpw5bf4XFPpBHL+bL4eivKHInrjJsdheowsej27Qli50+j31Y8x5u3YUOptGZmcAtLTyNw5oTGo8NhT7bfnL18btzUVfI+ZC5LRBUu/JF77zioh43HDUklPoAaRQKQVyByE8g8SQZYvtQy9hli50iOP2/tbWbnt/w3wICj0jWLAYWn7MpaDX5z92vz+3n69UaHeZNly/R0ChI+iZImXAZZmQW0wRuD1XYa46t0ah9ezc1mTELG2pNuNb8y410X2FNuIUOoIUsyvi8Ayji465IfSXAQdqbUI7SyeRUV0/3luMSmYQGUPvNQQKPYAuaKxAU9bQsPG8YV4Pkg68HszHQmTRbR4hdDUBbMpT12cnm/5c/rbnj6GXcHJ9to08zfS4hPYbWB/SE7Uu7OBbjhGFxFnI1xb7Dx2L+VjYtvb/KUJXgmENPMsLPXNXsSlPeq+AdMf2Jwj99Ay9EcL6kIbD7uPVGYhY7D5esX0IlBkfn5bUJUcO3bnzhO7/0GQusdeW9V6hm3lj59Z9Ys4RujBn+zmFTkQKWG903MFoCnqVXMpj1NKTuTDXUPs5hZ6KvQ+RCgXSTzdfrtrYxe7b+bJzyTEbsYFKoWnfvtKKDaowRmhcIqVGaJacwuQ6wY9a/nBnbwqdQe5A4aZJYkhm4VmFFqo9Sm9ZU8XNd80UOoPcgerJtilPeIyPMUKPxfbrk2MquXUK0dWuv6a2UOgMpgxUM+Ncx7Sj0DUUOhNdlKnxCFGWKvQcdeo9xUaFuVBoD3MM1BSeSWgBc+lBoVfBUoVeIhR6BVDodCj0CqDQ6VBoQgghhBBCCCGEEEIIIYQQksQ/Rq0/8z3UDAUAAAAASUVORK5CYII=",
  followersLegend: "iVBORw0KGgoAAAANSUhEUgAAAG4AAAAmCAYAAAAlUK76AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAGbSURBVHhe7ZfNcYMwEIV9kXxJHWkgfaSCdOBzwJNLCqCF1JAm3EImxm4mmfUMeHmRYIU9QMT7Zt7F+gHtZ4TYbAghhBBCCCGErJa63O5Opf+RYNtS0fd83LsnbP93NIuxRBYvY1LE1YX7xHmGImNwHuTrffNwuY/CH65j3flU+jdpw/4UtwBxIqYr7G++9/5Rj8lO3BhSxKVgFVeXrmr7lu6lecKOr/75Ks+du2MobnZxSlqFbfre9FOXpThZSGhRzTaHhdRF0AkVBPtYgtfT6Htttu5Ye2ctuYvTxViiOKHtxyduvDj9ewirjBS677jtLviOK/yhOyZDcZdTWkBcW4TSf+j+c4tb/akytuX1RcbMLU5Y9XfcOHGuGiMuNfcublbipgCFWBMqLvaxRubKWhwu2BKcw0LsyD7E0HstFooLBOewMFZciNiJGMlanJWUd1yIKcThH0zn1msuDlygJTiHBYq7M7hAS3AOYcxpNZa+7U+IiUOy3irbAtz4zUVxE4NFs6SvWFNAcRRHlgjFEUIIIYQQQgghJMovOgT9iYu2T3EAAAAASUVORK5CYII=",
};

function buildInstagramTrendChartImage({ report = {}, username = "instagram", date = "" } = {}) {
  const td = Array.isArray(report.trendData) ? report.trendData.filter((d) => d && d.date) : [];
  if (!td.length) return { attachment: null, cid: null };

  const labels = td.map((item) => {
    const parts = String(item.date || "").split("-");
    return parts.length === 3 ? `${+parts[1]}/${+parts[2]}` : String(item.date || "—");
  });
  const viewsSeries = td.map((item) => {
    const n = toChartNumber(item.dailyViews);
    return n != null && n >= 0 ? n : null;
  });
  const followerSeries = td.map((item) => {
    const n = toChartNumber(item.followerCount);
    return n != null && n > 0 ? n : null;
  });

  const chartValuesLeft = viewsSeries.filter((value) => value != null);
  const chartValuesRight = followerSeries.filter((value) => value != null);
  if (!chartValuesLeft.length && !chartValuesRight.length) {
    return { attachment: null, cid: null };
  }

  const leftScale = chartValuesLeft.length
    ? computeChartScale(chartValuesLeft, { minVisualRange: 200, paddingRatio: 0.16 })
    : { min: 0, max: 100 };
  const rightScale = chartValuesRight.length
    ? computeChartScale(chartValuesRight, { minVisualRange: 12, paddingRatio: 0.12 })
    : { min: 0, max: 100 };

  const width = 1120;
  const height = 420;
  const margin = { top: 74, right: 52, bottom: 56, left: 52 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const stepX = td.length > 1 ? chartWidth / (td.length - 1) : 0;
  const barWidth = Math.min(38, Math.max(20, chartWidth / Math.max(td.length * 2.8, 1)));
  const leftRange = Math.max(leftScale.max - leftScale.min, 1);
  const rightRange = Math.max(rightScale.max - rightScale.min, 1);
  const ticks = 5;

  const mapLeftY = (value) => margin.top + chartHeight - (((value - leftScale.min) / leftRange) * chartHeight);
  const mapRightY = (value) => margin.top + chartHeight - (((value - rightScale.min) / rightRange) * chartHeight);

  const gridLines = Array.from({ length: ticks }, (_, index) => {
    const ratio = index / (ticks - 1);
    return { y: margin.top + chartHeight - (ratio * chartHeight) };
  });

  const bars = viewsSeries.map((value, index) => {
    if (value == null) return "";
    const x = margin.left + (index * stepX) - (barWidth / 2);
    const y = mapLeftY(value);
    const barHeight = Math.max((margin.top + chartHeight) - y, 1);
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="8" fill="#6366f1" fill-opacity="0.30" stroke="#6366f1" stroke-width="1.2" />`;
  }).join("");

  const viewsValueLabels = viewsSeries.map((value, index) => {
    if (value == null) return "";
    const x = margin.left + (index * stepX);
    const yTop = mapLeftY(value);
    const barHeight = Math.max((margin.top + chartHeight) - yTop, 1);
    const y = yTop + (barHeight / 2) + 4;
    return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" font-size="14" font-weight="800" font-family="-apple-system,'Segoe UI','Malgun Gothic',sans-serif" fill="#5b5ff0">${escapeHtml(formatAxisNumber(value))}</text>`;
  }).join("");

  const lineSegments = [];
  let currentSegment = [];
  followerSeries.forEach((value, index) => {
    if (value == null) {
      if (currentSegment.length) lineSegments.push(currentSegment);
      currentSegment = [];
      return;
    }
    currentSegment.push({
      x: margin.left + (index * stepX),
      y: mapRightY(value),
      value,
    });
  });
  if (currentSegment.length) lineSegments.push(currentSegment);

  const linePaths = lineSegments.map((segment) => {
    const d = segment.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="#f59e0b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`;
  }).join("");

  const pointDots = lineSegments.map((segment) => segment.map((point) => `
    <circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="4.5" fill="#f59e0b" stroke="#ffffff" stroke-width="2" />
  `).join("")).join("");

  const followerValueLabels = followerSeries.map((value, index) => {
    if (value == null) return "";
    const x = margin.left + (index * stepX);
    const y = Math.max(mapRightY(value) - 14, margin.top + 32);
    return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" font-size="13" font-weight="700" font-family="-apple-system,'Segoe UI','Malgun Gothic',sans-serif" fill="#d97706">${escapeHtml(formatAxisNumber(value))}</text>`;
  }).join("");

  const labelNodes = labels.map((label, index) => `
    <text x="${(margin.left + (index * stepX)).toFixed(2)}" y="${(height - 18).toFixed(2)}" text-anchor="middle" font-size="15" font-weight="700" font-family="-apple-system,'Segoe UI','Malgun Gothic',sans-serif" fill="#64748b">${escapeHtml(label)}</text>
  `).join("");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Instagram follower and views trend chart">
  <defs>
    <linearGradient id="panelBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.82" />
      <stop offset="100%" stop-color="#f8fafc" stop-opacity="0.96" />
    </linearGradient>
    <radialGradient id="glowBg" cx="86%" cy="8%" r="48%">
      <stop offset="0%" stop-color="#6366f1" stop-opacity="0.09" />
      <stop offset="100%" stop-color="#6366f1" stop-opacity="0" />
    </radialGradient>
  </defs>

  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="24" fill="#fcfdff" />
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="24" fill="url(#panelBg)" />
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="24" fill="url(#glowBg)" />
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="24" fill="none" stroke="#94a3b8" stroke-opacity="0.22" />
  <g>
    <circle cx="46" cy="31" r="6" fill="#6366f1" />
    <image x="66" y="16" width="136" height="30" href="data:image/png;base64,${IG_CHART_LABEL_IMAGES.organicViewsLegend}" xlink:href="data:image/png;base64,${IG_CHART_LABEL_IMAGES.organicViewsLegend}" />
    <circle cx="178" cy="31" r="6" fill="#f59e0b" />
    <image x="192" y="16" width="74" height="30" href="data:image/png;base64,${IG_CHART_LABEL_IMAGES.followersLegend}" xlink:href="data:image/png;base64,${IG_CHART_LABEL_IMAGES.followersLegend}" />
  </g>

  <g>
    ${gridLines.map((tick) => `
      <line x1="${margin.left}" y1="${tick.y.toFixed(2)}" x2="${(width - margin.right).toFixed(2)}" y2="${tick.y.toFixed(2)}" stroke="#94a3b8" stroke-opacity="0.14" stroke-width="1" />
    `).join("")}

    ${bars}
    ${viewsValueLabels}
    ${linePaths}
    ${pointDots}
    ${followerValueLabels}
    ${labelNodes}
  </g>
</svg>`;

  const safeName = String(username || "instagram").replace(/[^a-zA-Z0-9_-]+/g, "_");
  const safeDate = String(date || "date").replace(/[^0-9-]+/g, "");
  const cid = `ig-trend-${safeName}-${safeDate}@sociallistener`;
  const pngBuffer = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: 960,
    },
  }).render().asPng();

  return {
    cid,
    attachment: {
      filename: `instagram-trend-${safeName}-${safeDate}.png`,
      content: pngBuffer,
      contentType: "image/png",
      cid,
    },
  };
}

const PLATFORM_META = {
  discord: {
    label: "Discord",
    labelEn: "Discord",
    color: "#5865F2",
    iconUrl: "https://sociallistener-8efde.web.app/icons/discord.svg",
    issueTone: { bg: "#eef2ff", border: "#5865F2", title: "#4338ca", body: "#3730a3" },
  },
  instagram: {
    label: "Instagram",
    labelEn: "Instagram",
    color: "#E1306C",
    iconUrl: "https://sociallistener-8efde.web.app/icons/instagram.svg",
  },
  facebook: {
    label: "Facebook 그룹",
    labelEn: "Facebook Group",
    color: "#1877F2",
    iconUrl: "https://sociallistener-8efde.web.app/icons/facebook.svg",
    issueTone: { bg: "#eff6ff", border: "#1877F2", title: "#1d4ed8", body: "#1e3a8a" },
  },
  naver_lounge: {
    label: "네이버 라운지",
    labelEn: "Naver Lounge",
    color: "#03C75A",
    iconUrl: "https://sociallistener-8efde.web.app/icons/naver-lounge.svg",
    issueTone: { bg: "#f0fdf4", border: "#03C75A", title: "#15803d", body: "#166534" },
  },
  facebook_page: {
    label: "Facebook 페이지",
    labelEn: "Facebook Page",
    color: "#1877F2",
    iconUrl: "https://sociallistener-8efde.web.app/icons/facebook.svg",
    issueTone: { bg: "#eff6ff", border: "#1877F2", title: "#1d4ed8", body: "#1e3a8a" },
  },
  dcinside: {
    label: "DCInside",
    labelEn: "DCInside",
    color: "#404E8E",
    iconUrl: "https://sociallistener-8efde.web.app/dc-icon.png",
    issueTone: { bg: "#eef0f8", border: "#404E8E", title: "#2e3a6e", body: "#1a2350" },
  },
  youtube: {
    label: "YouTube",
    labelEn: "YouTube",
    color: "#ff0033",
    iconUrl: "https://sociallistener-8efde.web.app/icons/youtube.svg",
    issueTone: { bg: "#fff1f2", border: "#ff0033", title: "#be123c", body: "#881337" },
  },
};

const DEFAULT_UNIFIED_THEME = Object.freeze({
  heroGradientFrom: "#f58529",
  heroGradientTo: "#8134af",
});

function normalizeHexColor(value, fallback) {
  const normalized = String(value || "").trim();
  return /^#(?:[0-9a-fA-F]{6})$/.test(normalized) ? normalized : fallback;
}

function normalizeUnifiedTheme(theme = {}) {
  return {
    heroGradientFrom: normalizeHexColor(theme.heroGradientFrom, DEFAULT_UNIFIED_THEME.heroGradientFrom),
    heroGradientTo: normalizeHexColor(theme.heroGradientTo, DEFAULT_UNIFIED_THEME.heroGradientTo),
  };
}

function extractBodyContent(html) {
  const match = String(html || "").match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return match ? match[1] : String(html || "");
}

function dedupeAttachments(attachments = []) {
  const seen = new Set();
  return attachments.filter((attachment) => {
    const key = [
      attachment?.cid || "",
      attachment?.filename || "",
      attachment?.contentType || "",
    ].join("::");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getUnifiedSectionMetrics(platform, report = {}, lang = "ko") {
  const isEN = lang === "en";
  if (platform === "discord") return [isEN ? `${report.messageCount || 0} messages` : `${report.messageCount || 0}개 메시지`];
  if (platform === "instagram") return [isEN ? `${Array.isArray(report.posts) ? report.posts.length : 0} posts` : `${Array.isArray(report.posts) ? report.posts.length : 0}개 포스트`];
  if (platform === "facebook" || platform === "facebook_page" || platform === "naver_lounge" || platform === "dcinside") {
    return [
      isEN ? `${report.postCount || 0} posts` : `${report.postCount || 0}개 게시글`,
      isEN ? `${report.totalComments || 0} comments` : `${report.totalComments || 0}개 댓글`,
    ];
  }
  if (platform === "youtube") {
    return [
      isEN ? `${report.relevantVideoCount || report.videoCount || 0} relevant videos` : `${report.relevantVideoCount || report.videoCount || 0}개 관련 영상`,
      isEN ? `${report.candidateVideoCount || report.videoCount || 0} candidates` : `${report.candidateVideoCount || report.videoCount || 0}개 후보`,
      isEN ? `${report.queryCount || 0} queries` : `${report.queryCount || 0}개 키워드`,
    ];
  }
  return [isEN ? `${report.postCount || 0} posts` : `${report.postCount || 0}개 게시글`];
}

function buildIssueLinkButton(url, {
  color = "#6366f1",
  borderColor = "#c7d2fe",
  label = "게시글 보기 ↗",
  radius = "999px",
  padding = "2px 8px",
} = {}) {
  if (!url || !String(url).startsWith("https://")) return "";
  return `<a href="${escapeHtml(url)}" style="display:inline-block;font-size:11px;color:${color};text-decoration:none;border:1px solid ${borderColor};border-radius:${radius};padding:${padding};margin-top:2px">${label}</a>`;
}

function resolveUnifiedPostUrl(report = {}, issue = {}) {
  return issue.postIndex
    ? (report.posts || [])[issue.postIndex - 1]?.postUrl || null
    : null;
}

function resolveUnifiedDiscordMessageUrl(report = {}, issue = {}) {
  const guildId = report.discordGuildId || report.guildId || "";
  if (!guildId || !issue.channelId || !issue.messageId) return null;
  return `https://discord.com/channels/${guildId}/${issue.channelId}/${issue.messageId}`;
}

function buildDiscordSection(report, issueTone, lang = "ko") {
  const isEN = lang === "en";
  const summary = isEN ? (report.summary_en || report.summary) : (report.summary || "");
  const sentiment = report.sentiment || {};
  const pos = sentiment.positive || 0;
  const neu = sentiment.neutral || 0;
  const neg = sentiment.negative || 0;
  const issues = (report.issues || []).slice(0, 3);
  const sentimentBar = (pos || neu || neg) ? `
    <div style="margin-bottom:12px">
      <div style="display:flex;height:8px;border-radius:999px;overflow:hidden;margin-bottom:6px;background:#e2e8f0">
        <div style="width:${pos}%;background:#059669"></div>
        <div style="width:${neu}%;background:#94a3b8"></div>
        <div style="width:${neg}%;background:#dc2626"></div>
      </div>
      <div style="font-size:12px;color:#64748b">
        <span style="color:#059669;font-weight:600">${isEN ? "Positive" : "긍정"} ${pos}%</span>
        <span style="margin:0 8px;color:#94a3b8">·</span>
        <span style="color:#64748b;font-weight:600">${isEN ? "Neutral" : "중립"} ${neu}%</span>
        <span style="margin:0 8px;color:#94a3b8">·</span>
        <span style="color:#dc2626;font-weight:600">${isEN ? "Negative" : "부정"} ${neg}%</span>
      </div>
    </div>` : "";
  const issueRows = issues.map((iss) => {
    const msgUrl = resolveUnifiedDiscordMessageUrl(report, iss);
    const metaParts = [];
    const issueTitle = isEN ? (iss.title_en || iss.title || "") : (iss.title || "");
    const issueDescription = isEN ? (iss.description_en || iss.description || "") : (iss.description || "");
    if (iss.count) metaParts.push(`<span style="display:inline-block;color:${issueTone.title};font-size:11px;margin-right:8px">${iss.count} ${isEN ? "mentions" : "회 언급"}</span>`);
    if (iss.channel) metaParts.push(`<span style="display:inline-block;color:${issueTone.title};font-size:11px;margin-right:8px">#${escapeHtml(iss.channel)}</span>`);
    if (msgUrl) metaParts.push(buildIssueLinkButton(msgUrl, {
      color: "#6366f1",
      borderColor: "#c7d2fe",
      label: isEN ? "View Message ↗" : "메시지 보기 ↗",
      radius: "4px",
      padding: "1px 6px",
    }));
    return `
    <div class="iss" style="background:${issueTone.bg};border-left:3px solid ${issueTone.border}">
      <div class="iss-t" style="color:${issueTone.title}">${escapeHtml(issueTitle)}</div>
      ${metaParts.length ? `<div style="margin-top:4px;line-height:1.8">${metaParts.join("")}</div>` : ""}
      <div class="iss-d" style="color:${issueTone.body}">${escapeHtml(issueDescription)}</div>
    </div>`;
  }).join("");

  return `
    ${sentimentBar}
    ${summary ? `<div class="dc-sum">${sanitizeReportHtml(summary)}</div>` : ""}
    ${issueRows ? `<div><div class="dc-ish">🚨 ${isEN ? "Key Issues" : "주요 이슈"}</div>${issueRows}</div>` : ""}`;
}

function buildInstagramSection(targetName, report, date, lang = "ko") {
  const isEN = lang === "en";
  const username = report.username || (targetName.startsWith("@") ? targetName.slice(1) : targetName);
  const attachments = [];
  const trendChartImage = buildInstagramTrendChartImage({ report, username, date });
  if (trendChartImage.attachment) attachments.push(trendChartImage.attachment);

  const trendSection = trendChartImage.cid ? `
    <div class="ig-trend">
      <div class="ig-h">${isEN ? "Followers · Views Trend (Last 14 Days)" : "팔로워 · 조회 트렌드 (최근 14일)"}</div>
      <div class="ig-tc"><img src="cid:${trendChartImage.cid}" alt="${isEN ? "Follower and organic views trend chart" : "팔로워 및 오가닉 조회 트렌드 차트"}" /></div>
    </div>` : "";

  const MEDIA_LABELS = isEN
    ? { IMAGE: "Photo", VIDEO: "Video", CAROUSEL_ALBUM: "Carousel" }
    : { IMAGE: "사진", VIDEO: "영상", CAROUSEL_ALBUM: "슬라이드" };
  const DOW = isEN ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : ["일", "월", "화", "수", "목", "금", "토"];
  const postRows = (report.posts || []).map((p) => {
    let dateStr = "—";
    if (p.timestamp) {
      const dtKST = new Date(new Date(p.timestamp).getTime() + 9 * 60 * 60 * 1000);
      dateStr = `${dtKST.getUTCMonth() + 1}/${dtKST.getUTCDate()}(${DOW[dtKST.getUTCDay()]})`;
    }
    const rawCap = p.caption ? normalizeCaptionText(p.caption) : null;
    const capText = rawCap ? escapeHtml(rawCap.length > 20 ? rawCap.slice(0, 20) + "…" : rawCap) : "—";
    const captionCell = (p.permalink && p.permalink.startsWith("https://"))
      ? `<a href="${p.permalink}" target="_blank" rel="noopener noreferrer" class="ig-a">${capText}</a>`
      : capText;
    const mediaLabel = MEDIA_LABELS[p.mediaType] || p.mediaType || "—";
    const er = p.engagementRate || 0;
    const erColor = er >= 5 ? "#059669" : er >= 2 ? "#d97706" : "#94a3b8";
    const erText = er > 0 ? `${er.toFixed(1)}%` : "—";
    const views = p.views != null ? p.views.toLocaleString() : "—";
    const likes = p.likes != null ? p.likes.toLocaleString() : "—";
    const comments = p.comments != null ? p.comments.toLocaleString() : "—";
    const shares = p.shares != null ? p.shares.toLocaleString() : "—";
    const saves = p.saves != null ? p.saves.toLocaleString() : "—";
    const pv = p.profileVisits != null ? p.profileVisits.toLocaleString() : "—";
    return `<tr>
      <td class="ig-tdd">${dateStr}</td>
      <td class="ig-tdc">${captionCell}</td>
      <td class="ig-tdt">${mediaLabel}</td>
      <td class="ig-tdr">${views}</td>
      <td class="ig-tdr">${likes}</td>
      <td class="ig-tdr">${comments}</td>
      <td class="ig-tdr">${shares}</td>
      <td class="ig-tdr">${saves}</td>
      <td class="ig-tdr">${pv}</td>
      <td class="ig-tdr" style="font-weight:600;color:${erColor}">${erText}</td>
    </tr>`;
  }).join("");

  const postTable = (report.posts || []).length > 0 ? `
    <div class="ig-ptw">
      <div class="ig-h">${isEN ? "Posts from the Last 7 Days (AI comments are shown in the dashboard)" : "최근 1주 포스트 (AI 코멘트는 대시보드에서 확인)"}</div>
      <div class="ig-scroll">
        <table class="ig-tbl">
          <thead><tr class="ig-thead-tr">
            <th class="ig-th">${isEN ? "Date" : "날짜"}</th>
            <th class="ig-th" style="width:96px">${isEN ? "Caption" : "본문"}</th>
            <th class="ig-th">${isEN ? "Type" : "유형"}</th>
            <th class="ig-th-r">${isEN ? "Views" : "조회"}</th>
            <th class="ig-th-r">${isEN ? "Likes" : "좋아요"}</th>
            <th class="ig-th-r">${isEN ? "Comments" : "댓글"}</th>
            <th class="ig-th-r">${isEN ? "Shares" : "공유"}</th>
            <th class="ig-th-r">${isEN ? "Saves" : "저장"}</th>
            <th class="ig-th-r">${isEN ? "Profile Visits" : "프로필방문"}</th>
            <th class="ig-th-r">${isEN ? "Engagement" : "참여율"}</th>
          </tr></thead>
          <tbody>${postRows}</tbody>
        </table>
      </div>
    </div>` : "";

  const performanceReview = isEN ? (report.aiPerformanceReview_en || report.aiPerformanceReview) : report.aiPerformanceReview;
  const perfBlock = performanceReview
    ? (() => {
        const lines = performanceReview.split("\n").filter((line) => line.trim());
        const linesHtml = lines.map((line) => formatReviewLine(line)).join("");
        return `<div class="ig-rev">
          <div class="ig-rev-in">
            <span class="ig-rev-t">${isEN ? "AI Performance Review — Last 7 Days Overview" : "AI 성과 리뷰 — 최근 1주 포스트 종합"}</span>
            <div class="ig-rev-b">${linesHtml}</div>
          </div>
        </div>`;
      })()
    : "";

  return { html: `${trendSection}${postTable}${perfBlock}`, attachments };
}

function buildUnifiedSentimentBar(sentiment = {}, lang = "ko", marginBottom = 12) {
  const isEN = lang === "en";
  const pos = sentiment.positive || 0;
  const neu = sentiment.neutral || 0;
  const neg = sentiment.negative || 0;
  if (!(pos || neu || neg)) return "";
  return `
    <div style="margin-bottom:${marginBottom}px">
      <div style="display:flex;height:8px;border-radius:999px;overflow:hidden;margin-bottom:6px;background:#e2e8f0">
        <div style="width:${pos}%;background:#059669"></div>
        <div style="width:${neu}%;background:#94a3b8"></div>
        <div style="width:${neg}%;background:#dc2626"></div>
      </div>
      <div style="font-size:12px;color:#64748b">
        <span style="color:#059669;font-weight:600">${isEN ? "Positive" : "긍정"} ${pos}%</span>
        <span style="margin:0 8px;color:#94a3b8">·</span>
        <span style="color:#64748b;font-weight:600">${isEN ? "Neutral" : "중립"} ${neu}%</span>
        <span style="margin:0 8px;color:#94a3b8">·</span>
        <span style="color:#dc2626;font-weight:600">${isEN ? "Negative" : "부정"} ${neg}%</span>
      </div>
    </div>`;
}

function buildCrawlerSection(report, accentColor, issueTone, lang = "ko", options = {}) {
  const isEN = lang === "en";
  const { showSentiment = false } = options;
  const summary = isEN ? (report.aiSummary_en || report.aiSummary) : (report.aiSummary || "");
  const sentimentBar = showSentiment ? buildUnifiedSentimentBar(report.aiSentiment || {}, lang) : "";
  const issues = (report.aiIssues || []).slice(0, 3);
  const issueRows = issues.map((iss) => {
    const postUrl = resolveUnifiedPostUrl(report, iss);
    const metaParts = [];
    const issueTitle = isEN ? (iss.title_en || iss.title || "") : (iss.title || "");
    const issueDescription = isEN ? (iss.description_en || iss.description || "") : (iss.description || "");
    if (iss.count) metaParts.push(`<span style="display:inline-block;color:${issueTone.title};font-size:11px;margin-right:8px">${iss.count} ${isEN ? "mentions" : "회 언급"}</span>`);
    if (iss.postIndex) metaParts.push(`<span style="display:inline-block;color:${issueTone.body};font-size:11px;margin-right:8px">${isEN ? "Post" : "게시글"} ${iss.postIndex}</span>`);
    if (postUrl) {
      metaParts.push(buildIssueLinkButton(postUrl, {
        color: accentColor,
        borderColor: hexToRgba(accentColor, 0.28),
        label: isEN ? "View Post ↗" : "게시글 보기 ↗",
      }));
    }
    return `
    <div class="cr-iss" style="background:${issueTone.bg};border-left:3px solid ${issueTone.border}">
      <div class="cr-iss-t" style="color:${issueTone.title}">${escapeHtml(issueTitle)}</div>
      ${metaParts.length ? `<div style="margin-top:4px;line-height:1.8">${metaParts.join("")}</div>` : ""}
      <div class="cr-iss-d" style="color:${issueTone.body}">${escapeHtml(issueDescription)}</div>
    </div>`;
  }).join("");

  return `
    ${sentimentBar}
    ${summary ? `<div class="cr-sum" style="border-left:3px solid ${accentColor}">${sanitizeReportHtml(formatSummaryHtml(summary))}</div>` : ""}
    ${issueRows ? `<div><div class="cr-ish">🚨 ${isEN ? "Key Issues" : "주요 이슈"}</div>${issueRows}</div>` : ""}`;
}

function buildDcinsideSection(report, accentColor, issueTone, lang = "ko") {
  const isEN = lang === "en";
  const summary = isEN ? (report.aiSummary_en || report.aiSummary) : (report.aiSummary || "");
  const issues = (report.aiIssues || []).slice(0, 3);
  const sentimentBar = buildUnifiedSentimentBar(report.aiSentiment || {}, lang);

  const issueRows = issues.map((iss) => {
    const postUrl = resolveUnifiedPostUrl(report, iss);
    const metaParts = [];
    const issueTitle = isEN ? (iss.title_en || iss.title || "") : (iss.title || "");
    const issueDescription = isEN ? (iss.description_en || iss.description || "") : (iss.description || "");
    if (iss.count) metaParts.push(`<span style="display:inline-block;color:${issueTone.title};font-size:11px;margin-right:8px">${iss.count} ${isEN ? "mentions" : "회 언급"}</span>`);
    if (iss.postIndex) metaParts.push(`<span style="display:inline-block;color:${issueTone.body};font-size:11px;margin-right:8px">${isEN ? "Post" : "게시글"} ${iss.postIndex}</span>`);
    if (postUrl) {
      metaParts.push(buildIssueLinkButton(postUrl, {
        color: accentColor,
        borderColor: hexToRgba(accentColor, 0.28),
        label: isEN ? "View Post ↗" : "게시글 보기 ↗",
      }));
    }
    return `
    <div class="cr-iss" style="background:${issueTone.bg};border-left:3px solid ${issueTone.border}">
      <div class="cr-iss-t" style="color:${issueTone.title}">${escapeHtml(issueTitle)}</div>
      ${metaParts.length ? `<div style="margin-top:4px;line-height:1.8">${metaParts.join("")}</div>` : ""}
      <div class="cr-iss-d" style="color:${issueTone.body}">${escapeHtml(issueDescription)}</div>
    </div>`;
  }).join("");

  return `
    ${sentimentBar}
    ${summary ? `<div class="cr-sum" style="border-left:3px solid ${accentColor}">${sanitizeReportHtml(formatSummaryHtml(summary))}</div>` : ""}
    ${issueRows ? `<div><div class="cr-ish">🚨 ${isEN ? "Key Issues" : "주요 이슈"}</div>${issueRows}</div>` : ""}`;
}

function buildYoutubeSection(report, accentColor, _issueTone, lang = "ko") {
  const isEN = lang === "en";
  const summary = isEN ? (report.aiSummary_en || report.aiSummary) : (report.aiSummary || "");
  const videos = (report.videos || []).slice(0, 6);
  const candidateVideoCount = Number(report.candidateVideoCount || report.videoCount || 0);
  const relevantVideoCount = Number(report.relevantVideoCount || report.videoCount || 0);
  const filteredOutVideoCount = Number(report.filteredOutVideoCount || 0);
  const emptyVideoMessage = candidateVideoCount > 0 && relevantVideoCount === 0
    ? (isEN ? "Candidates existed, but none remained after relevance filtering." : "후보 영상은 있었지만 관련성 판정 후 보고 대상이 남지 않았습니다.")
    : (isEN ? "No new videos were collected." : "새로 수집된 영상이 없습니다.");

  const rows = videos.map((video) => {
    const metrics = [
      video.viewCount != null ? `${isEN ? "Views" : "조회"} ${Number(video.viewCount).toLocaleString()}` : null,
      video.likeCount != null ? `${isEN ? "Likes" : "좋아요"} ${Number(video.likeCount).toLocaleString()}` : null,
      video.commentCount != null ? `${isEN ? "Comments" : "댓글"} ${Number(video.commentCount).toLocaleString()}` : null,
      video.duration ? `${isEN ? "Duration" : "길이"} ${escapeHtml(video.duration)}` : null,
    ].filter(Boolean).join(" · ");
    const queryChips = (video.matchedQueries || []).slice(0, 4).map((query) => `
      <span style="display:inline-block;padding:2px 7px;border-radius:999px;background:${hexToRgba(accentColor, 0.08)};color:${accentColor};font-size:10px;font-weight:700;margin:2px 6px 0 0">${escapeHtml(query)}</span>
    `).join("");
    return `
      <div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #eef2f7">
        <a href="${escapeHtml(video.videoUrl || "#")}" style="display:block;flex-shrink:0">
          <img src="${escapeHtml(video.thumbnailUrl || "")}" alt="${escapeHtml(video.title || "")}" style="width:120px;height:68px;border-radius:10px;object-fit:cover;background:#e2e8f0;display:block">
        </a>
        <div style="min-width:0;flex:1">
          <a href="${escapeHtml(video.videoUrl || "#")}" style="display:block;font-size:13px;font-weight:700;color:#0f172a;text-decoration:none;line-height:1.45">${escapeHtml(video.title || "(제목 없음)")}</a>
          <div style="font-size:11px;color:#64748b;margin-top:4px">${escapeHtml(video.channelTitle || "—")} · ${escapeHtml(video.duration || "—")}</div>
          <div style="font-size:11px;color:#475569;line-height:1.7;margin-top:4px">${metrics || (isEN ? "No public metrics" : "공개 지표 없음")}</div>
          ${queryChips ? `<div style="margin-top:6px">${queryChips}</div>` : ""}
        </div>
      </div>`;
  }).join("");

  return `
    ${summary ? `<div class="cr-sum" style="border-left:3px solid ${accentColor}">${sanitizeReportHtml(formatSummaryHtml(summary))}</div>` : ""}
    <div>
      <div style="font-size:11px;color:#64748b;margin-bottom:8px">${isEN ? `Candidates ${candidateVideoCount} · Relevant ${relevantVideoCount}` : `후보 ${candidateVideoCount}개 · 관련 ${relevantVideoCount}개`}${filteredOutVideoCount > 0 ? (isEN ? ` · Filtered/Held ${filteredOutVideoCount}` : ` · 제외/보류 ${filteredOutVideoCount}개`) : ""}</div>
      <div class="cr-ish">${isEN ? "New Uploads" : "신규 업로드"}</div>
      ${rows || `<div style="font-size:12px;color:#64748b;line-height:1.7">${emptyVideoMessage}</div>`}
    </div>`;
}

function buildUnifiedEmailHTML({ presetName, date, sections, theme = {}, lang = "ko" }) {
  const isEN = lang === "en";
  const displayDate = isEN ? formatENDate(date) : formatKSTDate(date);
  const allAttachments = [];
  const presetTheme = normalizeUnifiedTheme(theme);

  const sectionHtmls = sections.map(({ platform, targetName, report }, idx) => {
    const meta = PLATFORM_META[platform] || { label: platform, labelEn: platform, color: "#6366f1", iconUrl: "", issueTone: { bg: "#eef2ff", border: "#6366f1", title: "#4338ca", body: "#3730a3" } };
    const platformLabel = isEN ? (meta.labelEn || meta.label) : meta.label;
    const metricPills = getUnifiedSectionMetrics(platform, report, lang)
      .map((metric) => `<span class="sec-metric-pill" style="background:${meta.color}18;color:${meta.color}">${escapeHtml(metric)}</span>`)
      .join("");

    let bodyHtml = "";
    if (platform === "discord") {
      bodyHtml = buildDiscordSection(report, meta.issueTone, lang);
    } else if (platform === "instagram") {
      const result = buildInstagramSection(targetName, report, date, lang);
      bodyHtml = result.html;
      allAttachments.push(...result.attachments);
    } else if (platform === "facebook" || platform === "facebook_page" || platform === "naver_lounge") {
      bodyHtml = buildCrawlerSection(report, meta.color, meta.issueTone, lang, {
        showSentiment: platform === "naver_lounge",
      });
    } else if (platform === "dcinside") {
      bodyHtml = buildDcinsideSection(report, meta.color, meta.issueTone, lang);
    } else if (platform === "youtube") {
      bodyHtml = buildYoutubeSection(report, meta.color, meta.issueTone, lang);
    }

    const divider = idx > 0 ? `<div class="sec-div"></div>` : "";
    return `
      ${divider}
      <div class="sec">
        <div class="sec-shell" style="border-color:${meta.color}30;background:linear-gradient(180deg, ${meta.color}0f 0%, #ffffff 34%, #ffffff 100%)">
          <div class="sec-hero" style="background:linear-gradient(135deg, ${meta.color}24 0%, #ffffff 100%);border-bottom-color:${meta.color}24">
            <div class="sec-hero-top">
              <div class="sec-platform-row">
                <img class="sec-icon" src="${meta.iconUrl}" alt="${escapeHtml(platformLabel)}" />
                <span class="sec-platform-name" style="color:${meta.color}">${escapeHtml(platformLabel)}</span>
              </div>
              <div class="sec-metric-pills">${metricPills}</div>
            </div>
            <div class="sec-target">${escapeHtml(targetName)}</div>
          </div>
          <div class="sec-body" style="background:linear-gradient(180deg, ${meta.color}08 0%, #ffffff 24%, #ffffff 100%)">${bodyHtml}</div>
        </div>
      </div>`;
  }).join("");

  const tocChips = sections.map(({ platform, targetName }) => {
    const meta = PLATFORM_META[platform] || { label: platform, labelEn: platform, color: "#6366f1", iconUrl: "" };
    const platformLabel = isEN ? (meta.labelEn || meta.label) : meta.label;
    return `
      <span class="toc-chip" style="background:${meta.color}12;color:${meta.color};border-color:${meta.color}24">
        <img class="toc-chip-icon" src="${meta.iconUrl}" alt="${escapeHtml(platformLabel)}" />
        <span class="toc-chip-text">${escapeHtml(targetName)}</span>
      </span>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(presetName)} ${isEN ? "Integrated Report" : "통합 리포트"} (${date})</title>
  <style>
    body{margin:0;padding:0;background:#f8fafc;font-family:-apple-system,'Malgun Gothic','맑은 고딕',sans-serif}
    .wrap{max-width:640px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
    .hero{background:linear-gradient(135deg,${presetTheme.heroGradientFrom} 0%, ${presetTheme.heroGradientTo} 100%);padding:28px 32px}
    .hero-sub{color:rgba(255,255,255,.75);font-size:11px;letter-spacing:.08em;margin-bottom:6px}
    .hero-title{color:#fff;font-size:22px;font-weight:700}
    .hero-date{color:rgba(255,255,255,.8);font-size:14px;margin-top:4px}
    .toc{padding:18px 32px 10px;border-bottom:1px solid #f1f5f9}
    .toc-chips{font-size:0;line-height:0}
    .secs{padding-top:28px}
    .sec-div{border-top:2px dashed #e2e8f0;margin:0 32px 28px}
    .sec{padding:0 32px 28px}
    .sec-shell{border:1px solid transparent;border-radius:20px;overflow:hidden;background:#fff;box-shadow:0 12px 28px rgba(15,23,42,.06)}
    .sec-hero{padding:16px 18px 15px;border-bottom:1px solid transparent}
    .sec-hero-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
    .sec-platform-row{display:flex;align-items:center;gap:9px;min-width:0}
    .sec-icon{width:18px;height:18px;display:block;object-fit:contain}
    .sec-platform-name{font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
    .sec-metric-pills{display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-left:auto;flex-shrink:0;flex-wrap:wrap}
    .sec-metric-pill{display:inline-flex;align-items:center;justify-content:center;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;flex-shrink:0}
    .sec-target{font-size:18px;font-weight:700;color:#0f172a;line-height:1.3}
    .sec-body{padding:18px 18px 20px}
    .toc-chip{display:inline-block;vertical-align:top;white-space:nowrap;margin:0 8px 8px 0;padding:5px 11px;border-radius:999px;border:1px solid transparent;font-size:11px;font-weight:700;line-height:1.2}
    .toc-chip-icon{width:14px;height:14px;display:inline-block;vertical-align:middle;object-fit:contain;margin-right:7px}
    .toc-chip-text{display:inline-block;vertical-align:middle;white-space:nowrap}
    .ft{background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center}
    .dc-sum{font-size:13px;color:#374151;line-height:1.7;background:#f8fafc;border-left:3px solid #5865f2;border-radius:0 8px 8px 0;padding:12px 14px;margin-bottom:12px}
    .dc-ish{font-size:11px;font-weight:700;color:#64748b;margin-bottom:8px}
    .iss{padding:10px 12px;background:#ede9fe;border-left:3px solid #6366f1;border-radius:0 8px 8px 0;margin-bottom:6px}
    .iss-t{font-size:13px;font-weight:600;color:#4338ca}
    .iss-d{font-size:12px;color:#4c1d95;margin-top:2px}
    .ig-h{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6366f1;margin-bottom:10px}
    .ig-trend{margin-bottom:24px}
    .ig-tc{border:1px solid rgba(148,163,184,.22);border-radius:14px;overflow:hidden;background:#fcfdff}
    .ig-tc img{display:block;width:100%;height:auto;border:0;outline:none;text-decoration:none}
    .ig-a{color:#6366f1;text-decoration:none}
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
    .cr-sum{font-size:13px;color:#374151;line-height:1.8;padding:14px 16px;background:#f8fafc;border-radius:10px;margin-bottom:12px}
    .cr-ish{font-size:11px;font-weight:700;color:#64748b;margin-bottom:6px}
    .cr-iss{padding:10px 12px;background:#fff7ed;border-left:3px solid #f97316;border-radius:0 8px 8px 0;margin-bottom:6px}
    .cr-iss-t{font-size:12px;font-weight:600;color:#c2410c}
    .cr-iss-d{font-size:11px;color:#78350f;margin-top:2px}
  </style>
</head>
<body>
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(presetName)} ${isEN ? "Integrated Report" : "통합 리포트"} ${displayDate}</div>
  <div class="wrap">
    <div class="hero">
      <div class="hero-sub">AI SOCIAL LISTENING · INTEGRATED REPORT</div>
      <div class="hero-title">${escapeHtml(presetName)}</div>
      <div class="hero-date">${displayDate}</div>
    </div>
    <div class="toc"><div class="toc-chips">${tocChips}</div></div>
    <div class="secs">${sectionHtmls}</div>
    <div class="ft">${isEN ? "Social Listener by Strategy Team · This email is automatically sent" : "Social Listener by 사업전략팀 &nbsp;·&nbsp; 이 메일은 자동 발송됩니다"}</div>
  </div>
</body>
</html>`;

  return { html, attachments: allAttachments };
}

function buildUnifiedBilingualEmailHTML({
  presetNameKo,
  presetNameEn,
  date,
  sectionsEn,
  sectionsKo,
  theme = {},
}) {
  const { html: enHtml, attachments: enAttachments } = buildUnifiedEmailHTML({
    presetName: presetNameEn,
    date,
    sections: sectionsEn,
    theme,
    lang: "en",
  });
  const { html: koHtml, attachments: koAttachments } = buildUnifiedEmailHTML({
    presetName: presetNameKo,
    date,
    sections: sectionsKo,
    theme,
    lang: "ko",
  });
  const koBodyContent = extractBodyContent(koHtml);
  const divider = `
    <div style="margin:48px 24px 0;padding-top:36px;border-top:3px solid #e2e8f0;text-align:center">
      <span style="display:inline-block;padding:6px 20px;background:#f1f5f9;border-radius:20px;font-size:12px;font-weight:700;color:#64748b;letter-spacing:.08em;">── 한국어 리포트 ──</span>
    </div>
    ${koBodyContent}`;
  const html = enHtml.replace(/<\/body>/i, `${divider}\n</body>`);
  return {
    html,
    attachments: dedupeAttachments([...(enAttachments || []), ...(koAttachments || [])]),
  };
}

async function sendUnifiedEmailReport({
  recipients,
  presetName,
  presetNameKo = "",
  presetNameEn = "",
  date,
  sections,
  sectionsKo = null,
  theme = {},
  lang = "ko",
}) {
  const isEnglishBundle = lang === "en_ko";
  const isEN = lang === "en" || isEnglishBundle;
  const { html, attachments } = isEnglishBundle
    ? buildUnifiedBilingualEmailHTML({
      presetNameKo: String(presetNameKo || "").trim() || presetName,
      presetNameEn: String(presetNameEn || "").trim() || presetName,
      date,
      sectionsEn: sections,
      sectionsKo: Array.isArray(sectionsKo) ? sectionsKo : sections,
      theme,
    })
    : buildUnifiedEmailHTML({ presetName, date, sections, theme, lang });
  const mailOptions = {
    from: `Social Listener <${process.env.GMAIL_USER}>`,
    to: recipients.join(", "),
    subject: isEnglishBundle
      ? `[Social Listener] ${String(presetNameEn || "").trim() || presetName} - Integrated Report / 통합 리포트 (${date})`
      : isEN
      ? `[Social Listener] ${presetName} - Integrated Report (${date})`
      : `[Social Listener] ${presetName} - 통합 리포트 (${date})`,
    html,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
  await dispatchEmail(mailOptions);
}

module.exports = {
  sendUnifiedEmailReport,
  buildUnifiedEmailHTML,
};
