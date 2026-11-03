// Shared GitHub Projects V2 API helpers for ai_poc workflows.
// No third-party dependencies; Node.js 24+.
const API_ROOT = "https://api.github.com";
const DEFAULT_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "sitefee-ai-poc-controller",
};

export async function api(token, path, options = {}) {
  if (!token) throw new Error("GitHub token is not configured");
  const response = await fetch(API_ROOT + path, {
    method: options.method || "GET",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: "Bearer " + token,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("GitHub API " + response.status + " " + path + ": " +
      String(result.message || response.statusText));
  }
  return result;
}

export async function graphql(token, query, variables = {}) {
  const response = await api(token, "/graphql", {
    method: "POST",
    body: { query, variables },
  });
  if (response.errors?.length) {
    throw new Error("GitHub GraphQL: " + response.errors.map(error => error.message).join("; "));
  }
  return response.data;
}

export async function projectByTitle(token, owner, title) {
  let after = null;
  const matches = [];
  for (let page = 0; page < 20; page++) {
    const data = await graphql(token, `
      query($owner: String!, $after: String) {
        user(login: $owner) {
          projectsV2(first: 100, after: $after) {
            nodes { id number title }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`, { owner, after });
    const connection = data?.user?.projectsV2;
    if (!connection) throw new Error("Cannot access Projects for user " + owner);
    matches.push(...connection.nodes.filter(node => node.title === title));
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (page === 19) throw new Error("Project pagination limit reached");
  }
  if (matches.length !== 1) {
    throw new Error("Expected exactly one GitHub Project named '" + title +
      "', got " + matches.length);
  }
  return matches[0];
}

export async function projectItems(token, owner, projectNumber) {
  const items = [];
  let after = null;
  for (let page = 0; page < 100; page++) {
    const data = await graphql(token, `
      query($owner: String!, $number: Int!, $after: String) {
        user(login: $owner) {
          projectV2(number: $number) {
            items(first: 100, after: $after) {
              nodes {
                id
                content {
                  __typename
                  ... on Issue { number state repository { nameWithOwner } }
                }
                fieldValueByName(name: "Status") {
                  ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`, { owner, number: projectNumber, after });
    const connection = data?.user?.projectV2?.items;
    if (!connection) throw new Error("Unable to read Project items");
    items.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return items;
    after = connection.pageInfo.endCursor;
  }
  throw new Error("Project item pagination limit reached");
}

export async function projectFields(token, owner, projectNumber) {
  const fields = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = await graphql(token, `
      query($owner: String!, $number: Int!, $after: String) {
        user(login: $owner) {
          projectV2(number: $number) {
            fields(first: 100, after: $after) {
              nodes {
                ... on ProjectV2Field { id name dataType }
                ... on ProjectV2SingleSelectField {
                  id name options { id name }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`, { owner, number: projectNumber, after });
    const connection = data?.user?.projectV2?.fields;
    if (!connection) throw new Error("Unable to read Project fields");
    fields.push(...connection.nodes.filter(Boolean));
    if (!connection.pageInfo.hasNextPage) return fields;
    after = connection.pageInfo.endCursor;
  }
  throw new Error("Project field pagination limit reached");
}

export function findIssueItem(items, repo, issueNumber) {
  const matches = items.filter(item =>
    item.content?.__typename === "Issue" &&
    item.content.repository?.nameWithOwner?.toLowerCase() === repo.toLowerCase() &&
    item.content.number === issueNumber
  );
  if (matches.length !== 1) {
    throw new Error("Expected one Project item for " + repo + "#" + issueNumber +
      ", found " + matches.length + ". Check PAT scopes (project + repo for private repos).");
  }
  return matches[0];
}

export async function updateProjectField(token, projectId, itemId, fieldId, value) {
  return graphql(token, `
    mutation($input: UpdateProjectV2ItemFieldValueInput!) {
      updateProjectV2ItemFieldValue(input: $input) {
        projectV2Item { id }
      }
    }`, { input: { projectId, itemId, fieldId, value } });
}
