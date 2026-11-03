// Per-Issue preflight. Called before ANY Copilot request.
// GitHub Actions concurrency serializes attempts; this guard prevents a queued
// duplicate from doing AI work after the first attempt succeeds.
import { api, findIssueItem, projectByTitle, projectItems } from "./project-api.mjs";

const token = process.env.PROJECT_TOKEN;
const repoToken = process.env.GITHUB_TOKEN;
const repository = process.env.REPOSITORY;
const issueNumber = Number(process.env.ISSUE_NUMBER);
const stage = process.env.AI_STAGE;
const expectedUpdatedAt = process.env.STATUS_UPDATED_AT || "";

if (!token || !repoToken || !repository || !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 || !["analysis", "implement"].includes(stage)) {
  throw new Error("Missing or invalid AI job guard environment");
}

const [owner, repoName] = repository.split("/");
if (!owner || !repoName) throw new Error("Invalid REPOSITORY");
const repoPath = "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repoName);
const project = await projectByTitle(
  token,
  process.env.PROJECT_OWNER || "hoangdtdevelop",
  process.env.PROJECT_TITLE || "AI Development POC"
);
const item = findIssueItem(
  await projectItems(token, process.env.PROJECT_OWNER || "hoangdtdevelop", project.number),
  repository,
  issueNumber
);
const expectedStatus = stage === "analysis" ? "AI Analysis" : "AI Implementing";
const actualStatus = item.fieldValueByName?.name || "";
const transitionTime = item.fieldValueByName?.updatedAt;

if (actualStatus !== expectedStatus || item.content?.state !== "OPEN") {
  throw new Error("BLOCKED: Issue #" + issueNumber + " is not OPEN in " + expectedStatus +
    " (current status: " + (actualStatus || "(empty)") + ")");
}
if (!transitionTime || (expectedUpdatedAt && transitionTime !== expectedUpdatedAt)) {
  throw new Error("BLOCKED: Project Status changed since dispatch for Issue #" + issueNumber);
}

const comments = [];
for (let page = 1; page <= 20; page++) {
  const batch = await api(repoToken, repoPath + "/issues/" + issueNumber +
    "/comments?per_page=100&page=" + page);
  comments.push(...batch);
  if (batch.length < 100) break;
  if (page === 20) throw new Error("Too many comments to check safely");
}

if (stage === "analysis") {
  // Report from the CURRENT Status transition means analysis was already done.
  const alreadyAnalyzed = comments.some(comment =>
    comment.body?.startsWith("## AI Analysis Report (POC)") &&
    comment.created_at &&
    Date.parse(comment.created_at) >= Date.parse(transitionTime));
  if (alreadyAnalyzed) {
    throw new Error("BLOCKED: analysis report for this Status transition already exists.");
  }
} else {
  const hasAnalysis = comments.some(comment =>
    comment.body?.startsWith("## AI Analysis Report (POC)"));
  if (!hasAnalysis) {
    throw new Error("BLOCKED: no approved AI Analysis Report on Issue #" + issueNumber);
  }
  const branch = "ai/issue-" + issueNumber + "-html-update";
  const head = encodeURIComponent(owner + ":" + branch);
  const prs = await api(repoToken, repoPath +
    "/pulls?state=all&head=" + head + "&per_page=100");
  if (prs.length) {
    throw new Error("BLOCKED: a PR already exists for Issue #" + issueNumber);
  }
  const branchResponse = await fetch("https://api.github.com" + repoPath +
    "/git/ref/heads/" + branch, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + repoToken,
      "User-Agent": "sitefee-ai-poc-guard",
    },
  });
  if (branchResponse.ok) {
    throw new Error("BLOCKED: implementation branch already exists for Issue #" + issueNumber);
  }
  if (branchResponse.status !== 404) {
    throw new Error("Cannot verify implementation branch (HTTP " + branchResponse.status + ")");
  }
}

console.log("Preflight PASS: Issue #" + issueNumber + ", " + expectedStatus +
  " (transition " + transitionTime + ")");
