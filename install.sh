#!/bin/sh

set -eu

repository=${OPENCODE_SAFE_COMPACTION_REPO:-https://github.com/shyba/opencode-better-compact-plugin.git}
ref=${OPENCODE_SAFE_COMPACTION_REF:-default}
install_dir=${OPENCODE_SAFE_COMPACTION_DIR:-${HOME:?HOME must be set}/.local/share/opencode/plugins/safe-compaction}
config_dir=${OPENCODE_SAFE_COMPACTION_CONFIG_DIR:-${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}}
model=${OPENCODE_SAFE_COMPACTION_MODEL:-opencode-go/glm-5.2}
bun_command=${OPENCODE_SAFE_COMPACTION_BUN:-bun}
opencode_command=${OPENCODE_SAFE_COMPACTION_OPENCODE:-opencode}

fail() {
  printf 'opencode-safe-compaction: %s\n' "$1" >&2
  exit 1
}

say() {
  printf 'opencode-safe-compaction: %s\n' "$1"
}

resolve_command() {
  case "$1" in
    */*)
      [ -x "$1" ] || fail "executable not found: $1"
      printf '%s\n' "$1"
      ;;
    *)
      command -v "$1" 2>/dev/null || fail "required command not found: $1"
      ;;
  esac
}

canonical_repository() {
  case "$1" in
    git@github.com:*) printf 'github.com/%s\n' "${1#git@github.com:}" ;;
    ssh://git@github.com/*) printf 'github.com/%s\n' "${1#ssh://git@github.com/}" ;;
    https://github.com/*) printf 'github.com/%s\n' "${1#https://github.com/}" ;;
    http://github.com/*) printf 'github.com/%s\n' "${1#http://github.com/}" ;;
    *) printf '%s\n' "$1" ;;
  esac | sed 's#/*$##; s#\.git$##'
}

check_bun_version() {
  version=$("$bun_bin" --version)
  stable=${version%%-*}
  major=${stable%%.*}
  rest=${stable#*.}
  minor=${rest%%.*}
  patch=${rest#*.}
  case "$major.$minor.$patch" in
    *[!0-9.]*) fail "could not parse Bun version: $version" ;;
  esac
  if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 3 ]; } || {
    [ "$major" -eq 1 ] && [ "$minor" -eq 3 ] && [ "$patch" -lt 14 ]
  }; then
    fail "Bun $version is unsupported; install Bun 1.3.14 or newer"
  fi
}

check_opencode_version() {
  version=$("$opencode_bin" --version)
  stable=${version%%-*}
  major=${stable%%.*}
  rest=${stable#*.}
  minor=${rest%%.*}
  patch=${rest#*.}
  case "$major.$minor.$patch" in
    *[!0-9.]*) fail "could not parse OpenCode version: $version" ;;
  esac
  if [ "$major" -ne 1 ] || [ "$minor" -ne 18 ] || [ "$patch" -lt 4 ]; then
    fail "OpenCode $version is unsupported; this plugin requires >=1.18.4 <1.19.0"
  fi
}

case "$install_dir" in /*) ;; *) fail "install directory must be absolute: $install_dir" ;; esac
case "$config_dir" in /*) ;; *) fail "config directory must be absolute: $config_dir" ;; esac

git_bin=$(resolve_command git)
bun_bin=$(resolve_command "$bun_command")
opencode_bin=$(resolve_command "$opencode_command")
"$git_bin" check-ref-format --branch "$ref" >/dev/null 2>&1 || fail "invalid Git branch: $ref"
check_bun_version
check_opencode_version

if [ -e "$install_dir" ]; then
  [ -d "$install_dir/.git" ] || fail "install path exists but is not a Git checkout: $install_dir"
  actual_repository=$("$git_bin" -C "$install_dir" remote get-url origin 2>/dev/null) ||
    fail "existing checkout has no origin remote: $install_dir"
  [ "$(canonical_repository "$actual_repository")" = "$(canonical_repository "$repository")" ] ||
    fail "existing checkout origin does not match $repository"
  [ -z "$("$git_bin" -C "$install_dir" status --porcelain --untracked-files=normal)" ] ||
    fail "existing checkout has local changes; commit, stash, or remove them before updating"
  current_branch=$("$git_bin" -C "$install_dir" symbolic-ref --quiet --short HEAD 2>/dev/null) ||
    fail "existing checkout is detached; check out $ref before updating"
  [ "$current_branch" = "$ref" ] || fail "existing checkout is on $current_branch, expected $ref"
  say "updating $install_dir"
  "$git_bin" -C "$install_dir" fetch origin "$ref"
  "$git_bin" -C "$install_dir" merge --ff-only FETCH_HEAD
else
  say "cloning $repository into $install_dir"
  mkdir -p "$(dirname "$install_dir")"
  "$git_bin" clone --branch "$ref" --depth 1 -- "$repository" "$install_dir"
fi

OPENCODE_SAFE_COMPACTION_CONFIG_DIR=$config_dir \
OPENCODE_SAFE_COMPACTION_DIR=$install_dir \
OPENCODE_SAFE_COMPACTION_MODEL=$model \
  "$bun_bin" "$install_dir/scripts/configure.ts"

say "verifying the installed plugin with OpenCode"
debug_output=$(OPENCODE_CONFIG_DIR="$config_dir" \
  OPENCODE_DISABLE_PROJECT_CONFIG=true \
  OPENCODE_DISABLE_MODELS_FETCH=1 \
  "$opencode_bin" debug config) || fail "OpenCode could not load the installed configuration"
printf '%s' "$debug_output" | grep -F -e "$install_dir/src/index.ts" >/dev/null ||
  fail "OpenCode loaded the configuration but did not report the installed plugin path"
printf '%s' "$debug_output" | grep -F -e "$model" >/dev/null ||
  fail "OpenCode loaded the configuration but did not report the selected model"

say "installed successfully"
say "restart any running OpenCode server before using the plugin"
