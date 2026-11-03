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

// Human-triggered scan workflows are serialized by ai-controller.yml.
// Active-run check also catches jobs launched directly, outside this controller.
async function hasActiveIssueRun(workflow, number) {
  const title = (workflow === "ai-analysis.yml" ? "AI Analysis #" : "AI Implement #") + number;
  const active = new Set(["queued", "in_progress", "pending", "waiting", "requested"]);
  for (let page = 1; page <= 10; page++) {
    const response = await api(repoToken, repoPath + "/actions/workflows/" + workflow +
      "/runs?event=workflow_dispatch&per_page=100&page=" + page);
    const runs = response.workflow_runs || [];
    if (runs.some(run => run.display_title === title && active.has(run.status))) {
      return true;
    }
    if (runs.length < 100) return false;
  }
  throw new Error("Too many workflow runs to safely verify active jobs");
}

const project = await projectByTitle(projectToken, owner, projectTitle);
const items = await projectItems(projectToken, owner, project.number);
let dispatched = 0;
let skipped = 0;
let failed = 0;
log("Scanning Project '" + projectTitle + "' (" + items.length + " items)");

for (const item of items) {
  const status = item.fieldValueByName?.name || "(empty)";
  const issue = item.content;
  const issueLabel = issue?.__typename === "Issue"
    ? (issue.repository?.nameWithOwner || "(repository unavailable)") +
      "#" + (issue.number ?? "?")
    : "Project item " + item.id;

  log("FOUND " + issueLabel + " | Status: " + status +
    " | Issue state: " + (issue?.state || "N/A"));

  if (status !== "AI Analysis" && status !== "AI Implementing") {
    log("SKIP " + issueLabel + ": status '" + status + "' does not request AI work.");
    skipped++;
    continue;
  }
  if (issue?.__typename !== "Issue" || issue.state !== "OPEN") {
    log("SKIP " + issueLabel + ": item is not an open GitHub Issue.");
    skipped++;
    continue;
  }

  if (!issue.repository?.nameWithOwner) {
    throw new Error("Issue repository unavailable in Projects API. " +
      "Check PAT scope 'repo' for private repositories.");
  }
  if (issue.repository.nameWithOwner.toLowerCase() !== repository.toLowerCase()) {
    log("SKIP " + issueLabel + ": belongs to another repository.");
    skipped++;
    continue;
  }
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
  if (await hasActiveIssueRun(workflow, number)) {
    log("SKIP Issue #" + number + ": a " + workflow + " run is already queued or running.");
    skipped++;
    continue;
  }

  // CLAIM FIRST, then dispatch. If the dispatch request gets lost or times out,
  // keep the marker rather than accidentally running Copilot twice.
  // A serialized controller run + this marker covers repeated Scan clicks.
  const claim = await api(repoToken, repoPath + "/issues/" + number + "/comments", {
    method: "POST",
    body: {
      body: "AI Controller claimed **" + status + "** for Issue #" + number +
        ". Preparing to dispatch.\n\n" + marker,
    },
  });
  try {
    await api(repoToken,
      repoPath + "/actions/workflows/" + workflow + "/dispatches", {
        method: "POST",
        body: {
          ref: "main",
          inputs: {
            issue_number: String(number),
            status_updated_at: updatedAt,
          },
        },
      });
    dispatched++;
    log("DISPATCH Issue #" + number + " -> " + workflow);
    // Updating this human-readable message is best-effort: the claim stays.
    try {
      await api(repoToken, repoPath + "/issues/comments/" + claim.id, {
        method: "PATCH",
        body: {
          body: "AI Controller dispatched **" + status + "** for Issue #" + number +
            ". See the repository Actions tab.\n\n" + marker,
        },
      });
    } catch (error) {
      log("WARN Issue #" + number + ": dispatch succeeded; could not update claim comment.");
    }
  } catch (error) {
    // Never remove the claim after an uncertain dispatch. A retry requires a
    // conscious rerun, or moving Status away and back for a new transition key.
    log("ERROR Issue #" + number + ": dispatch result unknown; claim retained. " +
      "Check Actions before manually retrying. " + error.message);
    failed++;
  }
}

log("DONE: " + dispatched + " triggered, " + skipped + " skipped, " + failed + " uncertain/failed.");
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    "### AI Controller POC (manual scan)\n\n" +
    summary.map(line => "- " + line.replaceAll("\n", " ")).join("\n") + "\n");
}

if (failed) process.exitCode = 1;
