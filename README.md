# ai_poc

POC for GitHub Issue -> AI Analysis -> human approval -> AI Implementation -> PR.

## AI Analysis (OpenHands + OpenRouter)

Current phase: **manual Analysis only**. Implementation automation is not configured.

1. Create an **open GitHub Issue** in this repository.
2. Add the repository secret `OPENROUTER_API_KEY` under Settings > Secrets and variables > Actions.
3. Open **Actions > AI Analysis — OpenHands (manual) > Run workflow** on the default branch.
4. Enter the Issue number. The workflow will read the Issue and tracked source, run OpenHands with the OpenRouter model `nvidia/nemotron-3-ultra-550b-a55b:free`, validate its report, upload an artifact, and comment on that Issue.
5. Review the Analysis comment. Move the card to **Awaiting Approval** yourself; GitHub Project automation is intentionally not included yet.

The report includes relevant files, impact/risk, task breakdown, approximate hours, test suggestions, and the source revision. A failed run does **not** claim success or post a fabricated report: check the Actions logs.

The agent runs in an isolated *file-copy workspace* with the FileEditor tool only. It cannot push source or open PRs. This is **not a strong security sandbox** against malicious Issue content; do not run untrusted Issues or use sensitive source with this POC.

**Privacy:** The selected OpenRouter/NVIDIA free endpoint may log requests for service operation/improvement. Do not send confidential information or personal data.

**GitHub Projects status updates, auto polling, AI Implementing, and PR creation are not implemented in this phase.**
