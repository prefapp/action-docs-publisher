#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO="pre-vieitesss/features"
DOCS_REPO="pre-vieitesss/docs-e2e"
ACTION_REPO="prefapp/action-docs-publisher"
WORKFLOW_FILE=".github/workflows/docs-publisher.yml"
WORKFLOW_NAME="docs-publisher.yml"
WORK_BASE="/tmp/verify-docs-publisher-work"
EVIDENCE_BASE="/tmp/verify-docs-publisher-evidence"

die() {
  echo "sandbox.sh: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  sandbox.sh launch --sha <40-char-sha> [--run-id <id>]
  sandbox.sh doctor [--run-id <id>]
  sandbox.sh wait-run --event <event> [--head-sha <sha>] [--branch <branch>] [--after <iso-ts>] [--timeout <sec>] [--allow-failure]
  sandbox.sh capture --run-id <id> --feature <slug> --workflow-run-id <gh-run-id> [--pr <num>] [--docs-paths <p1,p2>]
  sandbox.sh cleanup --run-id <id>
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

validate_run_id() {
  [[ "$1" =~ ^[a-z0-9-]+$ ]] || die "invalid run-id '$1': use lowercase letters, digits, and hyphens only"
}

validate_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "invalid commit SHA '$1': pass a full 40-character commit SHA"
}

fetch_workflow() {
  gh api "repos/${SOURCE_REPO}/contents/${WORKFLOW_FILE}?ref=main" --jq '.content' | base64 -d
}

extract_pinned_action() {
  awk '/uses:[[:space:]]*prefapp\/action-docs-publisher@/ { sub(/.*@/, ""); gsub(/[[:space:]]+$/, ""); print; exit }'
}

extract_docs_branch() {
  awk '
    /docs-branch:[[:space:]]*\|-/ { found=1; next }
    found { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit }
  '
}

active_workflow_runs() {
  gh run list -R "${SOURCE_REPO}" -w "${WORKFLOW_NAME}" -L 20 --json databaseId,status,event,url \
    --jq '.[] | select((.status == "in_progress" or .status == "queued" or .status == "waiting") and (.event != "pull_request")) | "\(.databaseId) \(.status) \(.event) \(.url)"'
}

wait_for_run() {
  local event="" head_sha="" branch="" after="" timeout=300 allow_failure=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --event) event="$2"; shift 2 ;;
      --head-sha) head_sha="$2"; shift 2 ;;
      --branch) branch="$2"; shift 2 ;;
      --after) after="$2"; shift 2 ;;
      --timeout) timeout="$2"; shift 2 ;;
      --allow-failure) allow_failure=1; shift ;;
      *) die "unknown wait-run flag: $1" ;;
    esac
  done
  [[ -n "$event" ]] || die "wait-run requires --event"

  local deadline=$(( $(date +%s) + timeout ))
  local matched_id=""
  local matched_json=""

  while [[ $(date +%s) -lt $deadline ]]; do
    matched_json=$(gh run list -R "${SOURCE_REPO}" -w "${WORKFLOW_NAME}" --event "${event}" -L 15 \
      --json databaseId,status,conclusion,event,headBranch,headSha,createdAt,url | \
      node -e '
        const runs = JSON.parse(require("fs").readFileSync(0, "utf8"));
        const [headSha, branch, after] = process.argv.slice(1);
        const match = runs.find((r) => {
          if (headSha && r.headSha !== headSha) return false;
          if (branch && r.headBranch !== branch) return false;
          if (after && r.createdAt < after) return false;
          return true;
        });
        if (match) console.log(JSON.stringify(match));
      ' "${head_sha}" "${branch}" "${after}")

    if [[ -n "${matched_json}" ]]; then
      matched_id=$(printf '%s' "${matched_json}" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).databaseId)')
      local status
      status=$(printf '%s' "${matched_json}" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).status)')
      if [[ "${status}" == "completed" ]]; then
        printf '%s\n' "${matched_json}"
        local conclusion
        conclusion=$(printf '%s' "${matched_json}" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).conclusion)')
        if [[ "${conclusion}" != "success" && "${allow_failure}" -eq 0 ]]; then
          die "workflow run ${matched_id} concluded with '${conclusion}'"
        fi
        return 0
      fi
    fi
    sleep 5
  done

  die "timed out waiting for ${event} run (last matched id: ${matched_id:-none})"
}

cmd_launch() {
  local sha="" run_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --sha) sha="$2"; shift 2 ;;
      --run-id) run_id="$2"; shift 2 ;;
      *) die "unknown launch flag: $1" ;;
    esac
  done
  [[ -n "${sha}" ]] || die "launch requires --sha <40-char-sha>"
  validate_sha "${sha}"

  if [[ -z "${run_id}" ]]; then
    run_id="$(date -u +%Y%m%d-%H%M%S)-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 4 || true)"
  fi
  validate_run_id "${run_id}"

  # Verify the action commit is pushed and reachable on GitHub.
  gh api "repos/${ACTION_REPO}/commits/${sha}" --jq '.sha' >/dev/null 2>&1 \
    || die "commit ${sha} not found on ${ACTION_REPO}; push the commit first"

  # Concurrency guard: refuse to double-drive the shared sandbox workflow.
  local current_wf current_branch
  current_wf="$(fetch_workflow)"
  current_branch="$(printf '%s\n' "${current_wf}" | extract_docs_branch)"
  if [[ "${current_branch}" == verify-* ]]; then
    die "sandbox busy: ${SOURCE_REPO} ${WORKFLOW_FILE} already targets docs-branch '${current_branch}'"
  fi

  local running
  running="$(active_workflow_runs)"
  if [[ -n "${running}" ]]; then
    die "sandbox busy: active workflow runs on ${SOURCE_REPO}:${running}"
  fi

  local orig_features_sha orig_docs_sha docs_branch work_dir evidence_dir
  orig_features_sha="$(gh api "repos/${SOURCE_REPO}/git/ref/heads/main" --jq '.object.sha')"
  orig_docs_sha="$(gh api "repos/${DOCS_REPO}/git/ref/heads/main" --jq '.object.sha')"
  docs_branch="verify-${run_id}"
  work_dir="${WORK_BASE}/${run_id}"
  evidence_dir="${EVIDENCE_BASE}/${run_id}"

  mkdir -p "${work_dir}" "${evidence_dir}"
  printf '%s\n' "${current_wf}" > "${work_dir}/orig-workflow.yml"

  # Cut the disposable docs-e2e branch from main.
  gh api -X POST "repos/${DOCS_REPO}/git/refs" \
    -f "ref=refs/heads/${docs_branch}" \
    -f "sha=${orig_docs_sha}" >/dev/null

  # Clone features over SSH so workflow file pushes do not require OAuth workflow scope.
  git clone --branch main --single-branch "git@github.com:${SOURCE_REPO}.git" "${work_dir}/features" >/dev/null 2>&1

  node -e '
    const fs = require("fs");
    const [file, sha, branch] = process.argv.slice(1);
    let content = fs.readFileSync(file, "utf8");
    const actionRe = /(uses:\s*prefapp\/action-docs-publisher@)[0-9a-fA-F]+/;
    if (!actionRe.test(content)) throw new Error("action reference not found");
    content = content.replace(actionRe, `$1${sha}`);
    const branchRe = /(docs-branch:\s*\|-\r?\n[ \t]+)([^\r\n]+)/;
    if (!branchRe.test(content)) throw new Error("docs-branch block scalar not found");
    content = content.replace(branchRe, `$1${branch}`);
    fs.writeFileSync(file, content, "utf8");
  ' "${work_dir}/features/${WORKFLOW_FILE}" "${sha}" "${docs_branch}"

  git -C "${work_dir}/features" add "${WORKFLOW_FILE}"
  git -C "${work_dir}/features" commit -m "chore(verify): pin ${sha:0:7} for ${docs_branch}" >/dev/null
  local pin_sha
  pin_sha="$(git -C "${work_dir}/features" rev-parse HEAD)"

  cat > "${work_dir}/state.env" <<EOF
RUN_ID=${run_id}
ACTION_SHA=${sha}
DOCS_BRANCH=${docs_branch}
ORIG_FEATURES_MAIN_SHA=${orig_features_sha}
ORIG_DOCS_MAIN_SHA=${orig_docs_sha}
PIN_COMMIT_SHA=${pin_sha}
WORK_DIR=${work_dir}
EVIDENCE_DIR=${evidence_dir}
EOF

  git -C "${work_dir}/features" push origin main >/dev/null 2>&1

  local pin_run
  pin_run="$(wait_for_run --event push --head-sha "${pin_sha}" --timeout 300)"

  echo "RUN_ID=${run_id}"
  echo "DOCS_BRANCH=${docs_branch}"
  echo "ACTION_SHA=${sha}"
  echo "EVIDENCE_DIR=${evidence_dir}"
  echo "PIN_RUN=${pin_run}"
}

cmd_doctor() {
  local run_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --run-id) run_id="$2"; shift 2 ;;
      *) die "unknown doctor flag: $1" ;;
    esac
  done

  gh auth status >/dev/null 2>&1 || die "gh is not authenticated"

  local wf pinned_sha docs_branch active_runs docs_main_sha
  wf="$(fetch_workflow)"
  pinned_sha="$(printf '%s\n' "${wf}" | extract_pinned_action)"
  docs_branch="$(printf '%s\n' "${wf}" | extract_docs_branch)"
  active_runs="$(active_workflow_runs)"
  docs_main_sha="$(gh api "repos/${DOCS_REPO}/git/ref/heads/main" --jq '.object.sha')"

  echo "source_repo=${SOURCE_REPO}"
  echo "docs_repo=${DOCS_REPO}"
  echo "workflow_action_sha=${pinned_sha}"
  echo "workflow_docs_branch=${docs_branch}"
  echo "docs_main_sha=${docs_main_sha}"
  echo "active_runs=${active_runs:-none}"

  if [[ -n "${run_id}" ]]; then
    validate_run_id "${run_id}"
    local state_file="${WORK_BASE}/${run_id}/state.env"
    [[ -f "${state_file}" ]] || die "missing state file: ${state_file}"
    # shellcheck disable=SC1090
    source "${state_file}"

    [[ "${pinned_sha}" == "${ACTION_SHA}" ]] \
      || die "workflow action SHA mismatch: expected ${ACTION_SHA}, got ${pinned_sha}"
    [[ "${docs_branch}" == "${DOCS_BRANCH}" ]] \
      || die "workflow docs-branch mismatch: expected ${DOCS_BRANCH}, got ${docs_branch}"
    gh api "repos/${DOCS_REPO}/git/ref/heads/${DOCS_BRANCH}" --jq '.object.sha' >/dev/null 2>&1 \
      || die "docs branch ${DOCS_BRANCH} does not exist on ${DOCS_REPO}"
    [[ "${docs_main_sha}" == "${ORIG_DOCS_MAIN_SHA}" ]] \
      || die "${DOCS_REPO} main moved: expected ${ORIG_DOCS_MAIN_SHA}, got ${docs_main_sha}"
    [[ -z "${active_runs}" ]] \
      || die "active runs present on ${SOURCE_REPO}: ${active_runs}"
    echo "doctor=ok"
  fi
}

cmd_capture() {
  local run_id="" feature="" wf_run_id="" pr_num="" docs_paths=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --run-id) run_id="$2"; shift 2 ;;
      --feature) feature="$2"; shift 2 ;;
      --workflow-run-id) wf_run_id="$2"; shift 2 ;;
      --pr) pr_num="$2"; shift 2 ;;
      --docs-paths) docs_paths="$2"; shift 2 ;;
      *) die "unknown capture flag: $1" ;;
    esac
  done
  [[ -n "${run_id}" && -n "${feature}" && -n "${wf_run_id}" ]] \
    || die "capture requires --run-id, --feature, and --workflow-run-id"
  validate_run_id "${run_id}"

  local state_file="${WORK_BASE}/${run_id}/state.env"
  [[ -f "${state_file}" ]] || die "missing state file: ${state_file}"
  # shellcheck disable=SC1090
  source "${state_file}"

  local out_dir="${EVIDENCE_DIR}/${feature}"
  mkdir -p "${out_dir}"

  gh run view "${wf_run_id}" -R "${SOURCE_REPO}" \
    --json databaseId,url,event,status,conclusion,headBranch,headSha,createdAt,updatedAt,jobs \
    > "${out_dir}/run.json"
  gh run view "${wf_run_id}" -R "${SOURCE_REPO}" --log > "${out_dir}/run.log"
  gh api "repos/${DOCS_REPO}/commits?sha=${DOCS_BRANCH}&per_page=10" \
    --jq '[.[] | {sha: .sha, date: .commit.committer.date, message: .commit.message}]' \
    > "${out_dir}/docs-commits.json"

  if [[ -n "${pr_num}" ]]; then
    gh api "repos/${SOURCE_REPO}/issues/${pr_num}/comments" \
      --jq '[.[] | {id: .id, user: .user.login, updated_at: .updated_at, body: .body}]' \
      > "${out_dir}/pr-comments.json"
  fi

  if [[ -n "${docs_paths}" ]]; then
    mkdir -p "${out_dir}/docs-files"
    IFS=',' read -r -a paths_arr <<< "${docs_paths}"
    for p in "${paths_arr[@]}"; do
      local dest="${out_dir}/docs-files/${p}"
      mkdir -p "$(dirname "${dest}")"
      if gh api "repos/${DOCS_REPO}/contents/${p}?ref=${DOCS_BRANCH}" --jq '.content' 2>/dev/null | base64 -d > "${dest}.tmp"; then
        mv "${dest}.tmp" "${dest}"
      else
        rm -f "${dest}.tmp"
        printf 'NOT_FOUND (%s at %s)\n' "${p}" "${DOCS_BRANCH}" > "${dest}.missing"
      fi
    done
  fi

  echo "EVIDENCE_CAPTURED=${out_dir}"
}

cmd_cleanup() {
  local run_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --run-id) run_id="$2"; shift 2 ;;
      *) die "unknown cleanup flag: $1" ;;
    esac
  done
  [[ -n "${run_id}" ]] || die "cleanup requires --run-id"
  validate_run_id "${run_id}"

  local state_file="${WORK_BASE}/${run_id}/state.env"
  [[ -f "${state_file}" ]] || die "missing state file: ${state_file}"
  # shellcheck disable=SC1090
  source "${state_file}"

  # Close any open PRs created for this verification run and remove their branches.
  local pr_nums
  pr_nums="$(gh pr list -R "${SOURCE_REPO}" --state open --json number,headRefName \
    --jq ".[] | select(.headRefName | startswith(\"verify-${run_id}-\")) | .number")"
  for num in ${pr_nums}; do
    gh pr close "${num}" -R "${SOURCE_REPO}" --delete-branch >/dev/null 2>&1 || true
  done

  # Delete any remaining verify-<run-id>-* branches on features.
  local extra_branches
  extra_branches="$(gh api "repos/${SOURCE_REPO}/git/matching-refs/heads/verify-${run_id}-" --jq '.[].ref' 2>/dev/null || true)"
  for ref in ${extra_branches}; do
    gh api -X DELETE "repos/${SOURCE_REPO}/git/${ref}" >/dev/null 2>&1 || true
  done

  # Delete any releases and tags tagged with verify-<run-id>.
  local extra_tags
  extra_tags="$(gh api "repos/${SOURCE_REPO}/git/matching-refs/tags" --jq ".[].ref | select(contains(\"verify-${run_id}\") or contains(\"verify.${run_id}\"))" 2>/dev/null || true)"
  for ref in ${extra_tags}; do
    local tag="${ref#refs/tags/}"
    gh release delete "${tag}" -R "${SOURCE_REPO}" --yes --cleanup-tag >/dev/null 2>&1 \
      || gh api -X DELETE "repos/${SOURCE_REPO}/git/refs/tags/${tag}" >/dev/null 2>&1 \
      || true
  done

  # Restore pre-vieitesss/features main.
  git -C "${WORK_DIR}/features" fetch origin main >/dev/null 2>&1
  local current_main_sha non_verify_commits
  current_main_sha="$(git -C "${WORK_DIR}/features" rev-parse origin/main)"
  if [[ "${current_main_sha}" != "${ORIG_FEATURES_MAIN_SHA}" ]]; then
    non_verify_commits="$(git -C "${WORK_DIR}/features" log --format='%s' "${ORIG_FEATURES_MAIN_SHA}..origin/main" | grep -v "verify-${run_id}" || true)"
    local restore_after
    restore_after="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [[ -z "${non_verify_commits}" ]]; then
      git -C "${WORK_DIR}/features" checkout main >/dev/null 2>&1
      git -C "${WORK_DIR}/features" reset --hard "${ORIG_FEATURES_MAIN_SHA}" >/dev/null 2>&1
      git -C "${WORK_DIR}/features" push --force origin main >/dev/null 2>&1
    else
      echo "warning: unrelated commits landed on ${SOURCE_REPO} main; restoring ${WORKFLOW_FILE} by commit" >&2
      git -C "${WORK_DIR}/features" checkout main >/dev/null 2>&1
      git -C "${WORK_DIR}/features" reset --hard origin/main >/dev/null 2>&1
      cp "${WORK_DIR}/orig-workflow.yml" "${WORK_DIR}/features/${WORKFLOW_FILE}"
      git -C "${WORK_DIR}/features" add "${WORKFLOW_FILE}"
      git -C "${WORK_DIR}/features" commit -m "chore(verify): restore ${WORKFLOW_FILE} after verify-${run_id}" >/dev/null
      git -C "${WORK_DIR}/features" push origin main >/dev/null 2>&1
    fi
    # Wait for the restore push run so the sandbox is idle before returning.
    wait_for_run --event push --after "${restore_after}" --timeout 300 >/dev/null 2>&1 || true
  fi

  # Delete the disposable docs-e2e branch.
  gh api -X DELETE "repos/${DOCS_REPO}/git/refs/heads/${DOCS_BRANCH}" >/dev/null 2>&1 || true

  # Confirm docs-e2e main was never modified.
  local final_docs_main_sha
  final_docs_main_sha="$(gh api "repos/${DOCS_REPO}/git/ref/heads/main" --jq '.object.sha')"
  [[ "${final_docs_main_sha}" == "${ORIG_DOCS_MAIN_SHA}" ]] \
    || die "ERROR: ${DOCS_REPO} main changed during run (${ORIG_DOCS_MAIN_SHA} -> ${final_docs_main_sha})"

  # Remove scratch workspace, preserving evidence.
  rm -rf "${WORK_DIR}"

  [[ -d "${EVIDENCE_DIR}" ]] || die "evidence directory missing after cleanup: ${EVIDENCE_DIR}"
  echo "CLEANUP_OK=true"
  echo "DOCS_MAIN_UNCHANGED=${final_docs_main_sha}"
  echo "EVIDENCE_PRESERVED=${EVIDENCE_DIR}"
}

main() {
  require_cmd gh
  require_cmd git
  require_cmd node

  local cmd="${1:-}"
  shift || true
  case "${cmd}" in
    launch) cmd_launch "$@" ;;
    doctor) cmd_doctor "$@" ;;
    wait-run) wait_for_run "$@" ;;
    capture) cmd_capture "$@" ;;
    cleanup) cmd_cleanup "$@" ;;
    -h|--help|"") usage ;;
    *) die "unknown command: ${cmd}" ;;
  esac
}

main "$@"
