// Check or update one Issue's GitHub Project fields.
// Requires PROJECT_TOKEN with project and (for private repos) repo scope.
import { readFileSync, appendFileSync } from "node:fs";
import {
  findIssueItem,
  projectByTitle,
  projectFields,
  projectItems,
  updateProjectField,
} from "./project-api.mjs";

export function estimateHours(report) {
  const patterns = [
    /^\s*TOTAL_ESTIMATE_HOURS\s*:\s*(\d+(?:[.,]\d+)?)\s*$/im,
    /^\s*[-*]?\s*(?:Total|Tổng(?: cộng)?)[^:\n]*:\s*(\d+(?:[.,]\d+)?)/im,
  ];
  for (const pattern of patterns) {
    const match = report.match(pattern);
    if (!match) continue;
    const hours = Number(match[1].replace(",", "."));
    if (Number.isFinite(hours) && hours > 0 && hours <= 10000) return hours;
  }
  return null;
}

async function main() {
  const token = process.env.PROJECT_TOKEN;
  const owner = process.env.PROJECT_OWNER || "hoangdtdevelop";
  const title = process.env.PROJECT_TITLE || "AI Development POC";
  const repo = process.env.REPOSITORY;
  const number = Number(process.env.ISSUE_NUMBER);
  const expected = process.env.EXPECTED_STATUS;
  const next = process.env.TARGET_STATUS || "";
  const mode = process.env.PROJECT_MODE || "check";

  if (!token) throw new Error("Missing secret PROJECT_READ_TOKEN");
  if (!repo || !Number.isSafeInteger(number) || number < 1 || !expected) {
    throw new Error("REPOSITORY, ISSUE_NUMBER, EXPECTED_STATUS are required");
  }
  if (!["check", "update"].includes(mode)) throw new Error("Invalid PROJECT_MODE");

  const project = await projectByTitle(token, owner, title);
  const item = findIssueItem(await projectItems(token, owner, project.number), repo, number);
  const current = item.fieldValueByName?.name || "";
  console.log("Issue #" + number + " Project Status: " + current);
  if (current !== expected) {
    if (mode === "check") {
      throw new Error("Blocked: expected '" + expected + "' but got '" + current + "'");
    }
    console.log("Status changed since job started. Skipping Project updates.");
    return;
  }

  if (mode === "check") {
    console.log("Project Status gate PASSED for Issue #" + number);
    return;
  }

  const fields = await projectFields(token, owner, project.number);
  const reportPath = process.env.ESTIMATE_REPORT_PATH;
  if (reportPath) {
    const hours = estimateHours(readFileSync(reportPath, "utf8"));
    if (hours === null) {
      console.warn("Could not parse estimate hours; leaving Project Estimate unchanged.");
    } else {
      const estimate = fields.find(field =>
        field.name === "Estimate" && field.dataType === "NUMBER");
      if (!estimate) throw new Error("Project Estimate number field was not found");
      await updateProjectField(token, project.id, item.id, estimate.id, { number: hours });
      console.log("Updated Estimate = " + hours + " hours");
    }
  }

  if (next) {
    const status = fields.find(field =>
      field.name === "Status" && Array.isArray(field.options));
    const option = status?.options.find(value => value.name === next);
    if (!option) throw new Error("Project Status option not found: " + next);
    await updateProjectField(
      token, project.id, item.id, status.id, { singleSelectOptionId: option.id }
    );
    console.log("Updated Project Status: " + current + " -> " + next);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      "Issue #" + number + ": Project update completed (" + current + " -> " + (next || current) + ").\n");
  }
}

if (process.argv[1]?.endsWith("/project-status.mjs")) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
