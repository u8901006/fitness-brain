import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

const JOURNALS = [
  "Sports Medicine",
  "British Journal of Sports Medicine",
  "The American Journal of Sports Medicine",
  "Medicine & Science in Sports & Exercise",
  "Journal of Strength and Conditioning Research",
  "Journal of Science and Medicine in Sport",
  "Scandinavian Journal of Medicine & Science in Sports",
  "European Journal of Sport Science",
  "International Journal of Sports Physiology and Performance",
  "Sports Health",
  "Clinical Journal of Sport Medicine",
  "Current Sports Medicine Reports",
  "Journal of Sport and Health Science",
  "BMJ Open Sport & Exercise Medicine",
  "PTJ: Physical Therapy & Rehabilitation Journal",
  "Journal of Orthopaedic & Sports Physical Therapy",
  "Archives of Physical Medicine and Rehabilitation",
  "Clinical Rehabilitation",
  "Disability and Rehabilitation",
  "Physiotherapy",
  "Journal of Physiotherapy",
  "Physical Therapy in Sport",
  "Journal of Neurologic Physical Therapy",
  "Neurorehabilitation and Neural Repair",
  "Musculoskeletal Science and Practice",
  "Journal of Rehabilitation Medicine",
  "Nature Neuroscience",
  "Neuron",
  "The Journal of Neuroscience",
  "Neuroscience",
  "Brain",
  "Cerebral Cortex",
  "NeuroImage",
  "Trends in Neurosciences",
  "Current Opinion in Neurobiology",
  "Clinical Neurophysiology",
  "Frontiers in Neuroscience",
  "Psychological Science",
  "Clinical Psychological Science",
  "Journal of Consulting and Clinical Psychology",
  "Clinical Psychology Review",
  "Behaviour Research and Therapy",
  "Journal of Anxiety Disorders",
  "Journal of Affective Disorders",
  "Health Psychology",
  "Psychology of Sport and Exercise",
  "Journal of Sport and Exercise Psychology",
  "Frontiers in Psychology",
];

const TOPICS = [
  "resistance training",
  "strength training",
  "hypertrophy",
  "endurance",
  "aerobic exercise",
  "HIIT",
  "recovery",
  "sports injury",
  "concussion",
  "body composition",
  "VO2max",
  "rehabilitation",
  "physical therapy",
  "physiotherapy",
  "exercise therapy",
  "manual therapy",
  "gait",
  "balance",
  "pain",
  "return to sport",
  "stroke rehabilitation",
  "motor learning",
  "neuroplasticity",
  "neural circuits",
  "synaptic plasticity",
  "fMRI",
  "EEG",
  "TMS",
  "cognition",
  "memory",
  "hippocampus",
  "brain stimulation",
  "psychotherapy",
  "CBT",
  "motivation",
  "self-efficacy",
  "depression",
  "anxiety",
  "burnout",
  "adherence",
  "emotion regulation",
  "mental health",
  "exercise cognition",
  "exercise brain health",
  "BDNF",
  "executive function",
  "exercise adherence",
  "self-determination theory",
  "athlete mental health",
  "pain catastrophizing",
  "fear avoidance",
  "biopsychosocial rehabilitation",
];

const HEADERS = { "User-Agent": "FitnessBrainBot/1.0 (research aggregator)" };

function buildQuery(days = 7, maxJournals = 15) {
  const journalPart = JOURNALS.slice(0, maxJournals)
    .map((j) => `"${j}"[Journal]`)
    .join(" OR ");
  const now = new Date();
  const lookback = new Date(now.getTime() - days * 86400000);
  const lookbackStr = lookback.toISOString().slice(0, 10).replace(/-/g, "/");
  return `(${journalPart}) AND "${lookbackStr}"[Date - Publication] : "3000"[Date - Publication]`;
}

async function searchPapers(query, retmax = 50) {
  const params = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmax: String(retmax),
    sort: "date",
    retmode: "json",
  });
  try {
    const resp = await fetch(`${PUBMED_SEARCH}?${params}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const params = new URLSearchParams({
    db: "pubmed",
    id: pmids.join(","),
    retmode: "xml",
  });
  try {
    const resp = await fetch(`${PUBMED_FETCH}?${params}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(60000),
    });
    const xml = await resp.text();
    return parseXml(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "");
}

function parseXml(xml) {
  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    let title = titleMatch ? stripTags(titleMatch[1]).trim() : "";

    const absRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
    const abstracts = [];
    let absMatch;
    while ((absMatch = absRegex.exec(block)) !== null) {
      const labelMatch = absMatch[0].match(/Label="([^"]*)"/);
      const label = labelMatch ? labelMatch[1] : "";
      const text = stripTags(absMatch[1]).trim();
      if (text) abstracts.push(label ? `${label}: ${text}` : text);
    }
    const abstract = abstracts.join(" ").slice(0, 2000);

    const journalMatch = block.match(/<Title>([\s\S]*?)<\/Title>/);
    const journal = journalMatch ? journalMatch[1].trim() : "";

    const yearMatch = block.match(/<Year>(\d{4})<\/Year>/);
    const monthMatch = block.match(/<Month>([^<]+)<\/Month>/);
    const dayMatch = block.match(/<Day>(\d+)<\/Day>/);
    const parts = [yearMatch?.[1], monthMatch?.[1], dayMatch?.[1]].filter(Boolean);
    const dateStr = parts.join(" ");

    const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pmid = pmidMatch?.[1] || "";
    const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "";

    const kwRegex = /<Keyword>([\s\S]*?)<\/Keyword>/g;
    const keywords = [];
    let kwMatch;
    while ((kwMatch = kwRegex.exec(block)) !== null) {
      const kw = stripTags(kwMatch[1]).trim();
      if (kw) keywords.push(kw);
    }

    papers.push({ pmid, title, journal, date: dateStr, abstract, url, keywords });
  }
  return papers;
}

function getTaipeiDate() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}

async function main() {
  const { values } = parseArgs({
    options: {
      days: { type: "string", default: "7" },
      "max-papers": { type: "string", default: "50" },
      output: { type: "string", default: "papers.json" },
    },
  });

  const days = parseInt(values.days, 10);
  const maxPapers = parseInt(values["max-papers"], 10);
  const query = buildQuery(days);
  console.error(`[INFO] Searching PubMed for papers from last ${days} days...`);

  const pmids = await searchPapers(query, maxPapers);
  console.error(`[INFO] Found ${pmids.length} papers`);

  if (!pmids.length) {
    const output = {
      date: getTaipeiDate().toISOString().slice(0, 10),
      count: 0,
      papers: [],
    };
    writeFileSync(values.output, JSON.stringify(output, null, 2), "utf-8");
    console.error("[INFO] No papers found, saved empty result");
    return;
  }

  const papers = await fetchDetails(pmids);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const output = {
    date: getTaipeiDate().toISOString().slice(0, 10),
    count: papers.length,
    papers,
  };

  writeFileSync(values.output, JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Saved to ${values.output}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
