// Publishing (m7-contracts, "Publishing"): the GitHub release, through the user's own `gh` login. `gh` is an
// injected runner, (args) -> { status, stdout, stderr }; nothing here reads or prints a token.
//
// Endpoints (GitHub REST docs, read 2026-10-30), all read-only GETs through `gh api`:
// - GET /repos/{owner}/{repo}: private, visibility, default_branch.
//   https://docs.github.com/en/rest/repos/repos#get-a-repository
// - GET /repos/{owner}/{repo}/branches/{branch}: 404 until the default branch has a commit.
//   https://docs.github.com/en/rest/branches/branches#get-a-branch
// - GET /repos/{owner}/{repo}/immutable-releases: 200 { enabled, enforced_by_owner } when immutable releases are
//   on, 404 when they are off. https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository
// - GET /repos/{owner}/{repo}/rulesets?targets=tag&includes_parents=true, then
//   GET /repos/{owner}/{repo}/rulesets/{ruleset_id} for each (target, enforcement, conditions.ref_name, rules).
//   https://docs.github.com/en/rest/repos/rules#get-all-repository-rulesets
//   https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset
// - GET /repos/{owner}/{repo}/releases (drafts included for users with push access).
//   https://docs.github.com/en/rest/releases/releases#list-releases
// - GET /repos/{owner}/{repo}/git/matching-refs/tags/v<ver> (prefix match, so the exact ref is compared).
//   https://docs.github.com/en/rest/git/refs#list-matching-references
// - GET /repos/{owner}/{repo}/releases/tags/v<ver>: the published release, with its `immutable` flag ("a published
//   release with the specified tag", so a draft answers 404).
//   https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name
// Every check has an endpoint, so none is left as a manual checklist item.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { KEY_SHAPED_RE, PRODUCT_ID, RELEASE_REPO, UPDATE_URL, tagName } from "./release-config.js";
import { sha256 } from "./release-files.js";

const RELEASES_PAGE = `https://github.com/${RELEASE_REPO}/releases`;

export class PublishError extends Error {}

// The first line of a child's message, without anything token-shaped.
export function childLine(text) {
  const line = String(text ?? "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  return line
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[token]")
    .replace(new RegExp(KEY_SHAPED_RE.source, "g"), "[key]")
    .slice(0, 200);
}

function failure(result) {
  if (result.error) return result.error.code === "ENOENT" ? "gh is not installed or not on PATH" : childLine(result.error.message);
  return childLine(result.stderr) || `exit ${result.status}`;
}

async function ghOk(gh, args, what) {
  const result = await gh(args);
  if (result.status !== 0) throw new PublishError(`${what} failed: ${failure(result)}`);
  return result.stdout ?? "";
}

// gh api <path> as JSON; a 404 comes back as null when allowed.
async function ghApi(gh, apiPath, what, { allow404 = false, jq = null, paginate = false } = {}) {
  const args = ["api", ...(paginate ? ["--paginate"] : []), apiPath, ...(jq ? ["--jq", jq] : [])];
  const result = await gh(args);
  if (result.status !== 0) {
    if (allow404 && /HTTP 404/.test(String(result.stderr ?? ""))) return null;
    throw new PublishError(`${what} failed: ${failure(result)}`);
  }
  if (jq) return String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new PublishError(`${what}: gh gave no JSON`);
  }
}

// GitHub's ref patterns (fnmatch): ** any run, * and ? within one path segment, ~ALL everything.
export function refMatches(pattern, ref) {
  if (pattern === "~ALL") return true;
  if (pattern.startsWith("~")) return false;
  const full = pattern.startsWith("refs/") ? pattern : `refs/tags/${pattern}`;
  const source = full.split(/(\*\*|\*|\?)/).map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]"
    : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${source}$`).test(ref);
}

// An active tag ruleset whose conditions cover v* tags (this one and any later one) and whose rules forbid
// updating and deleting them.
export function protectsReleaseTags(ruleset, version) {
  if (ruleset?.target !== "tag" || ruleset.enforcement !== "active") return false;
  const include = ruleset.conditions?.ref_name?.include ?? [];
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  const covered = [`refs/tags/${tagName(version)}`, "refs/tags/v999.999.999"]
    .every((ref) => include.some((pattern) => refMatches(pattern, ref)) && !exclude.some((pattern) => refMatches(pattern, ref)));
  const types = new Set((ruleset.rules ?? []).map((rule) => rule?.type));
  return covered && types.has("update") && types.has("deletion");
}

// Step 1: the repo exists, is public, has a default branch with a commit, immutable releases, and a tag
// ruleset over v*. Returns { defaultBranch }; throws with every problem found.
export async function checkReleaseRepo(gh, { version }) {
  const repo = await ghApi(gh, `repos/${RELEASE_REPO}`, "reading the release repo", { allow404: true });
  if (!repo) throw new PublishError(`${RELEASE_REPO} does not exist, or gh can't see it (create it first; gh auth status shows the login)`);
  const problems = [];
  if (String(repo.full_name).toLowerCase() !== RELEASE_REPO.toLowerCase()) problems.push(`it answers as ${repo.full_name}`);
  if (repo.private !== false || (repo.visibility !== undefined && repo.visibility !== "public")) problems.push("it is not public");
  if (repo.archived) problems.push("it is archived");
  const defaultBranch = typeof repo.default_branch === "string" ? repo.default_branch : "";
  if (!defaultBranch) problems.push("it has no default branch");
  else if (!await ghApi(gh, `repos/${RELEASE_REPO}/branches/${encodeURIComponent(defaultBranch)}`, "reading the default branch", { allow404: true })) {
    problems.push(`its default branch ${defaultBranch} has no commit yet (push the README first)`);
  }
  const immutable = await ghApi(gh, `repos/${RELEASE_REPO}/immutable-releases`, "reading the immutable-releases setting", { allow404: true });
  if (immutable?.enabled !== true) problems.push("immutable releases are off (Settings > General > Releases)");
  const rulesets = await ghApi(gh, `repos/${RELEASE_REPO}/rulesets?targets=tag&includes_parents=true&per_page=100`, "listing the rulesets");
  let protectedTags = false;
  for (const summary of Array.isArray(rulesets) ? rulesets : []) {
    if (summary?.enforcement !== "active" || !Number.isInteger(summary.id)) continue;
    const ruleset = await ghApi(gh, `repos/${RELEASE_REPO}/rulesets/${summary.id}`, "reading a ruleset");
    if (protectsReleaseTags(ruleset, version)) {
      protectedTags = true;
      break;
    }
  }
  if (!protectedTags) problems.push("no active tag ruleset protects v* tags from update and deletion (Settings > Rules > Rulesets)");
  if (problems.length) throw new PublishError(`${RELEASE_REPO} is not ready: ${problems.join("; ")}`);
  return { defaultBranch };
}

// Step 2: neither a release (a leftover draft included) nor a tag v<ver> exists there yet. A draft is what a failed
// run leaves, and deleting it is safe; a published release is immutable and must never be deleted (its tag could not be
// used again), so the two get different advice. A published one this PC has no record of is a publish stopped between
// GitHub publishing it and the ledger write: the ledger's "signed" entry for it already holds every field a published
// entry needs, so only its state changes, and the local tag publish makes next was never made either (M7-REL-4).
// ledgerPath and commit (the signed entry's) name them in that advice.
export async function checkNotReleased(gh, { version, ledgerPath, commit }) {
  const tag = tagName(version);
  const releases = await ghApi(gh, `repos/${RELEASE_REPO}/releases?per_page=100`, "listing the releases", {
    paginate: true, jq: '.[] | "\\(.tag_name) \\(.draft)"',
  });
  const found = releases.map((line) => line.split(" ")).find(([name]) => name === tag);
  if (found?.[1] === "true") {
    throw new PublishError(`a draft release ${tag} already exists on ${RELEASES_PAGE}: a failed run left it; delete that draft there, then re-run publish`);
  }
  if (found) {
    throw new PublishError(`${tag} is already published on ${RELEASES_PAGE}, and immutable: do not delete it. If this PC has no record of it `
      + `(a publish stopped before it recorded the release), in ${ledgerPath} change the ${version} entry's "state" from "signed" to "published" `
      + `(keep every other field), then run git tag ${tag} ${commit} and node scripts/release.mjs verify --confirm ${version}; `
      + "otherwise bump to a new patch version");
  }
  const refs = await ghApi(gh, `repos/${RELEASE_REPO}/git/matching-refs/tags/${tag}`, "listing the tags", { jq: ".[].ref" });
  if (refs.includes(`refs/tags/${tag}`)) throw new PublishError(`tag ${tag} already exists in ${RELEASE_REPO}`);
}

// null when the update URL serves `local` naming `version`, else { text, pending }: pending when a later look may
// see it (the request failed), not when another file is served.
async function latestServes(fetchImpl, local, version) {
  const response = await fetchImpl(UPDATE_URL, { redirect: "follow", cache: "no-store" });
  if (!response.ok) return { text: `HTTP ${response.status}`, pending: true };
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.equals(local)) return { text: "it differs from the local updates.json", pending: false };
  let served = null;
  try {
    served = JSON.parse(body.toString("utf8"))?.addons?.[PRODUCT_ID]?.updates?.[0]?.version;
  } catch {
    served = null;
  }
  return served === version ? null : { text: `it does not name ${version}`, pending: false };
}

// Steps 1-4 up to the publish itself. assets: [{ name, file, sha256 }] (the xpi, updates.json, the CSS kit and
// SHA256SUMS); ledgerPath and commit only go into step 2's advice. A PublishError before the publish leaves at most a
// draft; the error says what to do. Resolves { defaultBranch } once the release is published, also when gh reported a
// failure but GitHub shows it published.
export async function publishRelease({ gh, log, version, assets, notesFile, downloadDir, ledgerPath, commit }) {
  const tag = tagName(version);
  const { defaultBranch } = await checkReleaseRepo(gh, { version });
  await checkNotReleased(gh, { version, ledgerPath, commit });
  log(`repo: ${RELEASE_REPO} is public, immutable releases on, v* tags protected, default branch ${defaultBranch}`);

  const repoArgs = ["--repo", RELEASE_REPO];
  try {
    await ghOk(gh, ["release", "create", tag, ...repoArgs, "--draft", "--target", defaultBranch, "--title", `Zen Tidy ${version}`, "--notes-file", notesFile], "creating the draft");
  } catch (error) {
    throw new PublishError(`${error.message}. Nothing is published; if a draft ${tag} appeared on ${RELEASES_PAGE}, delete it, then re-run publish`);
  }
  const draftLeft = (message) => new PublishError(`${message}. Nothing is published, only the draft ${tag}: delete it on ${RELEASES_PAGE}, then re-run publish`);
  try {
    await ghOk(gh, ["release", "upload", tag, ...repoArgs, ...assets.map((asset) => asset.file)], "uploading the assets");
    log(`draft ${tag}: ${assets.length} assets uploaded`);
    rmSync(downloadDir, { recursive: true, force: true });
    mkdirSync(downloadDir, { recursive: true });
    await ghOk(gh, ["release", "download", tag, ...repoArgs, "--dir", downloadDir], "downloading the assets back");
    for (const asset of assets) {
      let hash = null;
      try {
        hash = sha256(readFileSync(path.join(downloadDir, asset.name)));
      } catch {
        throw new PublishError(`the draft has no ${asset.name}`);
      }
      if (hash !== asset.sha256) throw new PublishError(`${asset.name} came back from the draft with SHA-256 ${hash}, not ${asset.sha256}`);
    }
    log(`draft ${tag}: ${assets.length} assets downloaded back, SHA-256 equal`);
  } catch (error) {
    throw draftLeft(error.message);
  }

  try {
    await ghOk(gh, ["release", "edit", tag, ...repoArgs, "--draft=false", "--latest"], "publishing the draft");
    log(`published ${tag} as latest`);
  } catch (error) {
    // gh can fail after GitHub has published (a timeout on the reply, say). A published release is immutable and
    // must still be recorded, so GitHub is asked before giving up.
    if (!await isPublished(gh, tag)) {
      throw new PublishError(`${error.message}. Look at ${RELEASES_PAGE}: if ${tag} is still a draft, delete it and re-run publish; `
        + "if it is published, it is immutable, so fix anything wrong with a new patch version");
    }
    log(`${error.message}, but GitHub shows ${tag} published: going on to record it`);
  }
  return { defaultBranch };
}

// Whether GitHub has v<ver> as a published release. The by-tag endpoint answers 404 for a draft; any failure to
// ask counts as not published.
async function isPublished(gh, tag) {
  try {
    const release = await ghApi(gh, `repos/${RELEASE_REPO}/releases/tags/${tag}`, "reading the release", { allow404: true });
    return release?.draft === false;
  } catch {
    return false;
  }
}

// Step 4's checks once the draft is published (and `release.mjs verify`'s): GitHub marks the release published and
// immutable, and the update URL every installed copy polls serves this updates.json. Both are retried (`attempts`
// reads, `delayMs` apart): GitHub's docs don't say the immutable flag is set the moment the release is published, and
// the "latest" redirect can take a moment. Only what is still wrong after the last attempt is reported.
// Returns { problems, pending }: problems empty when all is well; pending when every problem is one a later look may
// clear (M7-REL-2), so nothing is known to be wrong: a failed or timed-out request, or GitHub not showing the release
// published or immutable yet (publish confirmed immutable releases on before it published). Another file or another
// version at the update URL is wrong, not pending.
export async function verifyPublished({ gh, fetch: fetchImpl, sleep, version, updatesJson, attempts = 6, delayMs = 5000 }) {
  const tag = tagName(version);
  let release = [{ text: "not read yet", pending: true }];
  let served = { text: "not read yet", pending: true };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (release.length) release = await releaseProblems(gh, tag);
    if (served !== null) {
      try {
        served = await latestServes(fetchImpl, updatesJson, version);
      } catch (error) {
        served = { text: childLine(error.message) || "the request failed", pending: true };
      }
    }
    if (!release.length && served === null) break;
    if (attempt < attempts) await sleep(delayMs);
  }
  const problems = [...release, ...(served === null ? [] : [{ ...served, text: `${UPDATE_URL} does not serve this updates.json (${served.text})` }])];
  return { problems: problems.map((problem) => problem.text), pending: problems.length > 0 && problems.every((problem) => problem.pending) };
}

// What is wrong with the published release v<ver> as GitHub reports it now (empty when nothing), as [{ text, pending }]:
// each may clear on a later look.
async function releaseProblems(gh, tag) {
  try {
    const release = await ghApi(gh, `repos/${RELEASE_REPO}/releases/tags/${tag}`, "reading the published release");
    const problems = [];
    if (release?.draft !== false) problems.push({ text: `${tag} is not published`, pending: true });
    if (release?.immutable !== true) problems.push({ text: `GitHub does not mark ${tag} immutable`, pending: true });
    return problems;
  } catch (error) {
    return [{ text: error.message, pending: true }];
  }
}
