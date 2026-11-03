import { appendFileSync } from "node:fs";
import { api, projectByTitle, projectItems } from "./project-api.mjs";

const owner = process.env.PROJECT_OWNER || "hoangdtdevelop";
const projectTitle = process.env.PROJECT_TITLE || "AI Development POC";
const repository = process.env.REPOSITORY;
const projectToken = process.env.PROJECT_TOKEN;
const repoToken = process.env.GITHUB_TOKEN;
const maxDispatch = 10;

if (!repository || !projectToken || !repoToken) {
  throw new Error("REPOSITORY, PROJECT_TOKEN, and GITHUB_TOKEN are required.");
}
const [repoOwner, repoName] = repository.split("/");
if (!repoOwner || !repoName || repository.split("/").length !== 2) {
  throw new Error("Invalid GitHub repository: " + repository);
}
const repoPath = "/repos/" + encodeURIComponent(repoOwner) + "/" + encodeURIComponent(repoName);
const summary = [];
const log = message => { console.log(message); summary.push(message); };

async function commentsForIssue(number) {
  const comments = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await api(repoToken,
      repoPath + "/issues/" + number + "/comments?per_page=100&page=" + page);
    comments.push(...rows);
    if (rows.length < 100) return comments;
  }
  throw new Error("Too many comments to safely check Issue #" + number);
}

async function existingPrForIssue(number) {
  const headBranch = "ai/issue-" + number + "-html-update";
  const encodedHead = encodeURIComponent(repoOwner + ":" + headBranch);
  for (let page = 1; page <= 10; page++) {
    const rows = await api(repoToken, repoPath +
      "/pulls?state=all&head=" + encodedHead + "&per_page=100&page=" + page);
    if (rows.length) return rows[0].html_url;
    if (rows.length < 100) return "";
  }
  return "";
}

const project = await projectByTitle(projectToken, owner, projectTitle);
const items = await projectItems(projectToken, owner, project.number);
let dispatched = 0;
let skipped = 0;
log("Scanning Project '" + projectTitle + "' (" + items.length + " items)");

for (const item of items) {
  const status = item.fieldValueByName?.name;
  if (status !== "AI Analysis" && status !== "AI Implementing") continue;
  const issue = item.content;
  if (issue?.__typename !== "Issue" || issue.state !== "OPEN") continue;

  if (!issue.repository?.nameWithOwner) {
    throw new Error("Issue repository unavailable in Projects API. " +
      "Check PAT scope 'repo' for private repositories.");
  }
  if (issue.repository.nameWithOwner.toLowerCase() !== repository.toLowerCase()) continue;
  const number = issue.number;
  const updatedAt = item.fieldValueByName.updatedAt;
  if (!updatedAt) {
    throw new Error("Missing Status updatedAt for Issue #" + number);
  }
  const marker = "<!-- ai-poc-dispatch:" + number + ":" + status + ":" + updatedAt + " -->";
  const comments = await commentsForIssue(number);

  if (comments.some(comment => comment.body?.includes(marker))) {
    log("SKIP Issue #" + number + ": already dispatched for this Status change.");
    skipped++;
    continue;
  }

  if (status === "AI Implementing") {
    const hasAnalysis = comments.some(comment =>
      comment.body?.startsWith("## AI Analysis Report (POC)"));
    if (!hasAnalysis) {
      log("SKIP Issue #" + number + ": no AI Analysis Report found.");
      skipped++;
      continue;
    }
    const pr = await existingPrForIssue(number);
    if (pr) {
      log("SKIP Issue #" + number + ": PR already exists: " + pr);
      skipped++;
      continue;
    }
  }

  if (dispatched >= maxDispatch) {
    log("LIMIT reached (" + maxDispatch + " tasks); scan again for remaining work.");
    break;
  }

  const workflow = status === "AI Analysis" ? "ai-analysis.yml" : "ai-implement.yml";
  const result = await api(repoToken,
    repoPath + "/actions/workflows/" + workflow + "/dispatches", {
      method: "POST",
      body: { ref: "main", inputs: { issue_number: String(number) } },
    });

  // Marker is written only after dispatch accepted. One marker per Status transition.
  // If the downstream job fails, use 'Re-run jobs' on that job. Moving the card
  // away and back to the column creates a fresh Status timestamp for a new dispatch.
  await api(repoToken, repoPath + "/issues/" + number + "/comments", {
    method: "POST",
    body: {
      body: "AI Controller queued **" + status + "** for Issue #" + number +
        ". Run: " + (result?.html_url || "See repository Actions tab") +
        "\n\n" + marker,
    },
  });
  dispatched++;
  log("DISPATCH Issue #" + number + " -> " + workflow);
}

log("DONE: " + dispatched + " triggered, " + skipped + " skipped.");
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    "### AI Controller POC (manual scan)\n\n" +
    summary.map(line => "- " + line.replaceAll("\n", " ")).join("\n") + "\n");
}
