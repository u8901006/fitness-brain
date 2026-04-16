import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname } from "node:path";

const API_BASE = process.env.ZHIPU_API_BASE || "https://open.bigmodel.cn/api/coding/paas/v4";
const MODELS = ["glm-5-turbo", "glm-4.7", "glm-4.7-flash"];
const MAX_TOKENS = 100000;
const TIMEOUT = 660000;

const SYSTEM_PROMPT = `你是健身醫學、物理治療、神經科學與心理學領域的資深研究員與科學傳播者。你的任務是：
1. 從提供的醫學文獻中，篩選出最具臨床意義與研究價值的論文
2. 對每篇論文進行繁體中文摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合醫療專業人員與運動科學研究者閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP 5-8（最重要/最影響臨床實踐的論文）
回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

function loadPapers(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function safeJsonParse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const nl = cleaned.indexOf("\n");
    cleaned = nl >= 0 ? cleaned.slice(nl + 1) : cleaned.slice(3);
    cleaned = cleaned.replace(/```+\s*$/, "").trim();
  }
  const lb = cleaned.lastIndexOf("}");
  if (lb >= 0 && lb < cleaned.length - 1) cleaned = cleaned.slice(0, lb + 1);
  if (lb < 0) { const lb2 = cleaned.lastIndexOf("]"); if (lb2 >= 0) cleaned = cleaned.slice(0, lb2 + 1); }
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  for (let i = cleaned.length; i > 10; i--) { try { return JSON.parse(cleaned.slice(0, i)); } catch {} }
  return null;
}

async function analyzePapers(apiKey, papersData) {
  const dateStr = papersData.date || new Date().toISOString().slice(0, 10);
  const paperCount = papersData.count || 0;
  const papersText = JSON.stringify(papersData.papers || [], null, 2);

  const prompt = `以下是 ${dateStr} 從 PubMed 抓取的最新健身醫學/物理治療/神經科學/心理學文獻（共 ${paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": { "population": "研究對象", "intervention": "介入措施", "comparison": "對照組", "outcome": "主要結果" },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    { "title_zh": "中文標題", "title_en": "English Title", "journal": "期刊名", "summary": "一句話總結", "clinical_utility": "高/中/低", "tags": ["標籤1"], "url": "連結", "emoji": "emoji" }
  ],
  "keywords": ["關鍵字1"],
  "topic_distribution": { "運動訓練": 3 }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：運動訓練、肌力與體能、運動傷害、腦震盪、耐力訓練、HIIT、恢復、身體組成、心肺適能、物理治療、復健醫學、骨科復健、神經復健、疼痛管理、步態訓練、平衡訓練、運動控制、神經可塑性、腦影像、腦刺激、認知功能、記憶、海馬迴、心理治療、CBT、動機、自我效能、憂鬱症、焦慮症、運動心理學、運動依從性、情緒調節、心理健康、BDNF、執行功能、生物力學、運動生理學、老年醫學、兒少發展。
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;

  const headers = { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" };

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const resp = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST", headers,
          body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], temperature: 0.3, top_p: 0.9, max_tokens: MAX_TOKENS }),
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (resp.status === 429) { const w = 60000 * (attempt + 1); console.error(`[WARN] Rate limited, waiting ${w/1000}s...`); await new Promise(r => setTimeout(r, w)); continue; }
        if (!resp.ok) { const t = await resp.text().catch(() => ""); console.error(`[ERROR] HTTP ${resp.status}: ${t.slice(0,200)}`); if (resp.status >= 500) { await new Promise(r => setTimeout(r, 10000)); continue; } break; }
        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content || "";
        const result = safeJsonParse(text);
        if (!result) { console.error(`[WARN] JSON parse failed on attempt ${attempt + 1}`); if (attempt < 2) await new Promise(r => setTimeout(r, 5000)); continue; }
        console.error(`[INFO] Analysis complete: ${(result.top_picks||[]).length} top picks, ${(result.all_papers||[]).length} total`);
        return result;
      } catch (e) { if (e.name === "TimeoutError") { console.error(`[WARN] ${model} timeout on attempt ${attempt + 1}`); } else { console.error(`[ERROR] ${model} failed: ${e.message}`); } if (attempt < 2) await new Promise(r => setTimeout(r, 5000)); }
    }
  }
  console.error("[ERROR] All models and attempts failed");
  return null;
}

function escHtml(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function generateHtml(analysis, usedModel) {
  const dateStr = analysis.date || new Date().toISOString().slice(0, 10);
  const [y, m, d] = dateStr.split("-");
  const dateDisplay = `${y}年${parseInt(m)}月${parseInt(d)}日`;
  const weekdays = ["日","一","二","三","四","五","六"];
  const weekday = weekdays[new Date(dateStr).getDay()];
  const summary = escHtml(analysis.market_summary || "");
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;

  let topPicksHtml = "";
  for (const pick of topPicks) {
    const tagsHtml = (pick.tags||[]).map(t => `<span class="tag">${escHtml(t)}</span>`).join("");
    const util = pick.clinical_utility || "\u4e2d";
    const uClass = util === "\u9ad8" ? "utility-high" : util === "\u4e2d" ? "utility-mid" : "utility-low";
    const pico = pick.pico || {};
    const picoHtml = pico.population ? `\n            <div class="pico-grid">\n              <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${escHtml(pico.population)}</span></div>\n              <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${escHtml(pico.intervention)}</span></div>\n              <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${escHtml(pico.comparison)}</span></div>\n              <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${escHtml(pico.outcome)}</span></div>\n            </div>` : "";
    topPicksHtml += `\n        <div class="news-card featured">\n          <div class="card-header">\n            <span class="rank-badge">#${pick.rank||""}</span>\n            <span class="emoji-icon">${pick.emoji||"\uD83D\uDCC4"}</span>\n            <span class="${uClass}">${escHtml(util)}實用性</span>\n          </div>\n          <h3>${escHtml(pick.title_zh||pick.title_en||"")}</h3>\n          <p class="journal-source">${escHtml(pick.journal||"")} &middot; ${escHtml(pick.title_en||"")}</p>\n          <p>${escHtml(pick.summary||"")}</p>\n          ${picoHtml}\n          <div class="card-footer">\n            ${tagsHtml}\n            <a href="${escHtml(pick.url||"#")}" target="_blank">閱讀原文 →</a>\n          </div>\n        </div>`;
  }

  let allPapersHtml = "";
  for (const paper of allPapers) {
    const tagsHtml = (paper.tags||[]).map(t => `<span class="tag">${escHtml(t)}</span>`).join("");
    const util = paper.clinical_utility || "\u4e2d";
    const uClass = util === "\u9ad8" ? "utility-high" : util === "\u4e2d" ? "utility-mid" : "utility-low";
    allPapersHtml += `\n        <div class="news-card">\n          <div class="card-header-row">\n            <span class="emoji-sm">${paper.emoji||"\uD83D\uDCC4"}</span>\n            <span class="${uClass} utility-sm">${escHtml(util)}</span>\n          </div>\n          <h3>${escHtml(paper.title_zh||paper.title_en||"")}</h3>\n          <p class="journal-source">${escHtml(paper.journal||"")}</p>\n          <p>${escHtml(paper.summary||"")}</p>\n          <div class="card-footer">\n            ${tagsHtml}\n            <a href="${escHtml(paper.url||"#")}" target="_blank">PubMed →</a>\n          </div>\n        </div>`;
  }

  const keywordsHtml = keywords.map(k => `<span class="keyword">${escHtml(k)}</span>`).join("");
  let topicBarsHtml = "";
  if (Object.keys(topicDist).length) {
    const maxCount = Math.max(...Object.values(topicDist), 1);
    for (const [topic, count] of Object.entries(topicDist)) {
      const width = Math.round((count / maxCount) * 100);
      topicBarsHtml += `\n            <div class="topic-row">\n              <span class="topic-name">${escHtml(topic)}</span>\n              <div class="topic-bar-bg"><div class="topic-bar" style="width:${width}%"></div></div>\n              <span class="topic-count">${count}</span>\n            </div>`;
    }
  }

  const CSS = `:root{--bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;--muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf;--card-bg:color-mix(in srgb,var(--surface) 92%,white)}*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{background:radial-gradient(circle at top,#fff6ea 0,var(--bg) 55%,#ead8c6 100%);color:var(--text);font-family:"Noto Sans TC","PingFang TC","Helvetica Neue",Arial,sans-serif;min-height:100vh;overflow-x:hidden}.container{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:60px 32px 80px}header{display:flex;align-items:center;gap:16px;margin-bottom:52px;animation:fadeDown .6s ease both}.logo{width:48px;height:48px;border-radius:14px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;box-shadow:0 4px 20px rgba(140,79,43,.25)}.header-text h1{font-size:22px;font-weight:700;color:var(--text);letter-spacing:-.3px}.header-meta{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center}.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;letter-spacing:.3px}.badge-date{background:var(--accent-soft);border:1px solid var(--line);color:var(--accent)}.badge-count{background:rgba(140,79,43,.06);border:1px solid var(--line);color:var(--muted)}.badge-source{background:transparent;color:var(--muted);font-size:11px;padding:0 4px}.summary-card{background:var(--card-bg);border:1px solid var(--line);border-radius:24px;padding:28px 32px;margin-bottom:32px;box-shadow:0 20px 60px rgba(61,36,15,.06);animation:fadeUp .5s ease .1s both}.summary-card h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.6px;color:var(--accent);margin-bottom:16px}.summary-text{font-size:15px;line-height:1.8;color:var(--text)}.section{margin-bottom:36px;animation:fadeUp .5s ease both}.section-title{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700;color:var(--text);margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line)}.section-icon{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;background:var(--accent-soft)}.news-card{background:var(--card-bg);border:1px solid var(--line);border-radius:24px;padding:22px 26px;margin-bottom:12px;box-shadow:0 8px 30px rgba(61,36,15,.04);transition:background .2s,border-color .2s,transform .2s}.news-card:hover{transform:translateY(-2px);box-shadow:0 12px 40px rgba(61,36,15,.08)}.news-card.featured{border-left:3px solid var(--accent)}.news-card.featured:hover{border-color:var(--accent)}.card-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}.rank-badge{background:var(--accent);color:#fff7f0;font-weight:700;font-size:12px;padding:2px 8px;border-radius:6px}.emoji-icon{font-size:18px}.card-header-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}.emoji-sm{font-size:14px}.news-card h3{font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px;line-height:1.5}.journal-source{font-size:12px;color:var(--accent);margin-bottom:8px;opacity:.8}.news-card p{font-size:13.5px;line-height:1.75;color:var(--muted)}.card-footer{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.tag{padding:2px 9px;background:var(--accent-soft);border-radius:999px;font-size:11px;color:var(--accent)}.news-card a{font-size:12px;color:var(--accent);text-decoration:none;opacity:.7;margin-left:auto}.news-card a:hover{opacity:1}.utility-high{color:#5a7a3a;font-size:11px;font-weight:600;padding:2px 8px;background:rgba(90,122,58,.1);border-radius:4px}.utility-mid{color:#9f7a2e;font-size:11px;font-weight:600;padding:2px 8px;background:rgba(159,122,46,.1);border-radius:4px}.utility-low{color:var(--muted);font-size:11px;font-weight:600;padding:2px 8px;background:rgba(118,100,83,.08);border-radius:4px}.utility-sm{font-size:10px}.pico-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;padding:12px;background:rgba(255,253,249,.8);border-radius:14px;border:1px solid var(--line)}.pico-item{display:flex;gap:8px;align-items:baseline}.pico-label{font-size:10px;font-weight:700;color:#fff7f0;background:var(--accent);padding:2px 6px;border-radius:4px;flex-shrink:0}.pico-text{font-size:12px;color:var(--muted);line-height:1.4}.keywords-section{margin-bottom:36px}.keywords{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.keyword{padding:5px 14px;background:var(--accent-soft);border:1px solid var(--line);border-radius:20px;font-size:12px;color:var(--accent);cursor:default;transition:background .2s}.keyword:hover{background:rgba(140,79,43,.18)}.topic-section{margin-bottom:36px}.topic-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}.topic-name{font-size:13px;color:var(--muted);width:100px;flex-shrink:0;text-align:right}.topic-bar-bg{flex:1;height:8px;background:var(--line);border-radius:4px;overflow:hidden}.topic-bar{height:100%;background:linear-gradient(90deg,var(--accent),#c47a4a);border-radius:4px;transition:width .6s ease}.topic-count{font-size:12px;color:var(--accent);width:24px}.clinic-banner{margin-top:48px;animation:fadeUp .5s ease .4s both}.clinic-link{display:flex;align-items:center;gap:14px;padding:18px 24px;background:var(--card-bg);border:1px solid var(--line);border-radius:24px;text-decoration:none;color:var(--text);transition:all .2s;box-shadow:0 8px 30px rgba(61,36,15,.04)}.clinic-link:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 12px 40px rgba(61,36,15,.08)}.clinic-icon{font-size:28px;flex-shrink:0}.clinic-name{font-size:15px;font-weight:700;color:var(--text);flex:1}.clinic-arrow{font-size:18px;color:var(--accent);font-weight:700}footer{margin-top:32px;padding-top:22px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted);display:flex;justify-content:space-between;animation:fadeUp .5s ease .5s both}footer a{color:var(--muted);text-decoration:none}footer a:hover{color:var(--accent)}@keyframes fadeDown{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}@media(max-width:600px){.container{padding:36px 18px 60px}.summary-card,.news-card{padding:20px 18px}.pico-grid{grid-template-columns:1fr}footer{flex-direction:column;gap:6px;text-align:center}.topic-name{width:70px;font-size:11px}}`;

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Fitness Brain &middot; 健身醫學文獻日報 &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 健身醫學/物理治療/神經科學/心理學文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>${CSS}</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">💪</div>
    <div class="header-text">
      <h1>Fitness Brain &middot; 健身醫學文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">📅 ${dateDisplay}（週${weekday}）</span>
        <span class="badge badge-count">📊 ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>
  <div class="summary-card">
    <h2>📋 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>
  ${topPicksHtml ? `<div class="section"><div class="section-title"><span class="section-icon">⭐</span>今日精選 TOP Picks</div>${topPicksHtml}</div>` : ""}
  ${allPapersHtml ? `<div class="section"><div class="section-title"><span class="section-icon">📚</span>其他值得關注的文獻</div>${allPapersHtml}</div>` : ""}
  ${topicBarsHtml ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">📊</span>主題分佈</div>${topicBarsHtml}</div>` : ""}
  ${keywordsHtml ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">🏷️</span>關鍵字</div><div class="keywords">${keywordsHtml}</div></div>` : ""}
  <div class="clinic-banner">
    <a href="https://www.leepsyclinic.com/" class="clinic-link" target="_blank">
      <span class="clinic-icon">🏥</span>
      <span class="clinic-name">李政洋身心診所首頁</span>
      <span class="clinic-arrow">→</span>
    </a>
  </div>
  <div class="clinic-banner" style="margin-top:12px;animation-delay:0.5s">
    <a href="https://blog.leepsyclinic.com/" class="clinic-link" target="_blank">
      <span class="clinic-icon">📬</span>
      <span class="clinic-name">訂閱電子報</span>
      <span class="clinic-arrow">→</span>
    </a>
  </div>
  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${escHtml(usedModel)}</span>
    <span><a href="https://github.com/u8901006/fitness-brain">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "papers.json" },
      output: { type: "string", default: "docs/fitness-today.html" },
      "api-key": { type: "string", default: "" },
      date: { type: "string", default: "" },
    },
  });
  const apiKey = values["api-key"] || process.env.ZHIPU_API_KEY || "";
  if (!apiKey) { console.error("[ERROR] No API key. Set ZHIPU_API_KEY env var or use --api-key"); process.exit(1); }
  const papersData = loadPapers(values.input);
  let analysis;
  let usedModel = MODELS[0];
  if (!papersData || !papersData.papers?.length) {
    console.error("[WARN] No papers found, generating empty report");
    const dateStr = values.date || new Date().toISOString().slice(0, 10);
    analysis = { date: dateStr, market_summary: "今日 PubMed 暫無新的健身醫學/物理治療/神經科學/心理學文獻更新。請明天再查看。", top_picks: [], all_papers: [], keywords: [], topic_distribution: {} };
  } else {
    analysis = await analyzePapers(apiKey, papersData);
    if (!analysis) { console.error("[ERROR] Analysis failed, cannot generate report"); process.exit(1); }
  }
  const targetDate = values.date || analysis.date || new Date().toISOString().slice(0, 10);
  const outputFile = values.output === "docs/fitness-today.html" ? `docs/fitness-${targetDate}.html` : values.output;
  const html = generateHtml(analysis, usedModel);
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, html, "utf-8");
  console.error(`[INFO] Report saved to ${outputFile}`);
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
