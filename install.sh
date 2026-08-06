#!/bin/sh

set -eu

repository=${OPENCODE_SAFE_COMPACTION_REPO:-https://github.com/shyba/opencode-better-compact-plugin.git}
ref=${OPENCODE_SAFE_COMPACTION_REF:-default}
install_dir=${OPENCODE_SAFE_COMPACTION_DIR:-${HOME:?HOME must be set}/.local/share/opencode/plugins/safe-compaction}
config_dir=${OPENCODE_SAFE_COMPACTION_CONFIG_DIR:-${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}}
if [ "${OPENCODE_SAFE_COMPACTION_MODEL+x}" = x ]; then
  model=$OPENCODE_SAFE_COMPACTION_MODEL
  model_explicit=1
else
  model=selected
  model_explicit=0
fi
unset OPENCODE_SAFE_COMPACTION_PRESERVE_SOURCE
unset OPENCODE_SAFE_COMPACTION_SERVER_ENTRY
unset OPENCODE_SAFE_COMPACTION_TUI_ENTRY
bun_command=${OPENCODE_SAFE_COMPACTION_BUN:-bun}
opencode_command=${OPENCODE_SAFE_COMPACTION_OPENCODE:-opencode}
bun_bootstrap_version=1.3.14

fail() {
  printf 'opencode-safe-compaction: %s\n' "$1" >&2
  exit 1
}

say() {
  printf 'opencode-safe-compaction: %s\n' "$1"
}

case "$model" in
  selected) ;;
  */*)
    provider=${model%%/*}
    model_id=${model#*/}
    [ -n "$provider" ] && [ -n "$model_id" ] || fail "model must be selected or use provider/model format: $model"
    case "$model" in *[[:space:]]*) fail "model must be selected or use provider/model format: $model" ;; esac
    ;;
  *) fail "model must be selected or use provider/model format: $model" ;;
esac

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
    *) printf '%s\n' "$1" ;;
  esac | sed 's#/*$##; s#\.git$##'
}

reject_insecure_repository() {
  case "$1" in
    [Hh][Tt][Tt][Pp]://*|[Gg][Ii][Tt]://*) fail "insecure repository URL is not allowed: $1" ;;
  esac
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

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    output=$(sha256sum "$1") || return 1
    printf '%s\n' "${output%% *}"
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    output=$(shasum -a 256 "$1") || return 1
    printf '%s\n' "${output%% *}"
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    output=$(openssl dgst -sha256 "$1") || return 1
    printf '%s\n' "${output##* }"
    return
  fi
  fail "a SHA-256 tool is required to verify the temporary Bun download (sha256sum, shasum, or openssl)"
}

bootstrap_bun() {
  system=$(uname -s 2>/dev/null) || fail "could not determine the operating system for the temporary Bun download"
  machine=$(uname -m 2>/dev/null) || fail "could not determine the architecture for the temporary Bun download"
  case "$machine" in
    x86_64|amd64) architecture=x64 ;;
    aarch64|arm64) architecture=aarch64 ;;
    *) fail "automatic Bun bootstrap does not support architecture: $machine; set OPENCODE_SAFE_COMPACTION_BUN" ;;
  esac

  case "$system:$architecture" in
    Linux:x64)
      libc=glibc
      if command -v ldd >/dev/null 2>&1; then
        ldd_version=$(ldd --version 2>&1 || true)
        case "$ldd_version" in *musl*) libc=musl ;; esac
      fi
      if [ "$libc" = "musl" ]; then
        asset=bun-linux-x64-musl-baseline
        expected_sha256=56a7d6806cf155536c0178f0ea5fbd098e684fa509ebdb4fc0a7e19fb65382dc
      else
        asset=bun-linux-x64-baseline
        expected_sha256=a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7
      fi
      ;;
    Linux:aarch64)
      libc=glibc
      if command -v ldd >/dev/null 2>&1; then
        ldd_version=$(ldd --version 2>&1 || true)
        case "$ldd_version" in *musl*) libc=musl ;; esac
      fi
      if [ "$libc" = "musl" ]; then
        asset=bun-linux-aarch64-musl
        expected_sha256=b98e0ad3625c5c00d1d5b5ff55605c7adddbfae151861e68ade57b2d3b8703bb
      else
        asset=bun-linux-aarch64
        expected_sha256=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b
      fi
      ;;
    Darwin:x64)
      asset=bun-darwin-x64-baseline
      expected_sha256=3e35ad6f53971a9834bf9e6786e2adf72b5f1921cc9a9c5fde073d2972944076
      ;;
    Darwin:aarch64)
      asset=bun-darwin-aarch64
      expected_sha256=d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620
      ;;
    FreeBSD:x64)
      asset=bun-freebsd-x64-baseline
      expected_sha256=cf24aff5d2b7d7c1d9838f58ae6162a5565e87584495fb8bcd2cfbae4f645d92
      ;;
    FreeBSD:aarch64)
      asset=bun-freebsd-aarch64
      expected_sha256=73c5c19059fde409137fc6cbab5905fc7c5afa58ce60e41a41a521c23fff66bb
      ;;
    *) fail "automatic Bun bootstrap does not support platform: $system/$machine; set OPENCODE_SAFE_COMPACTION_BUN" ;;
  esac

  curl_bin=$(resolve_command curl)
  archive=$transaction_dir/$asset.zip
  url=https://github.com/oven-sh/bun/releases/download/bun-v$bun_bootstrap_version/$asset.zip
  say "Bun not found; downloading temporary Bun $bun_bootstrap_version for $system/$machine"
  "$curl_bin" --proto '=https' --tlsv1.2 --location --fail --silent --show-error --retry 3 --output "$archive" "$url" ||
    fail "could not download temporary Bun $bun_bootstrap_version"
  actual_sha256=$(file_sha256 "$archive") || fail "could not hash the temporary Bun download"
  [ "$actual_sha256" = "$expected_sha256" ] || fail "temporary Bun download failed SHA-256 verification"

  bootstrap_dir=$transaction_dir/bun-bootstrap
  mkdir -m 700 "$bootstrap_dir"
  if unzip_bin=$(command -v unzip 2>/dev/null); then
    "$unzip_bin" -q "$archive" -d "$bootstrap_dir" || fail "could not extract the temporary Bun download"
  elif busybox_bin=$(command -v busybox 2>/dev/null); then
    "$busybox_bin" unzip -q "$archive" -d "$bootstrap_dir" || fail "could not extract the temporary Bun download"
  else
    fail "unzip or busybox is required to extract the temporary Bun download"
  fi
  bun_bin=$bootstrap_dir/$asset/bun
  [ -f "$bun_bin" ] || fail "temporary Bun archive did not contain the expected executable"
  chmod 700 "$bun_bin"
}

select_bun() {
  if [ "${OPENCODE_SAFE_COMPACTION_BUN+x}" = x ]; then
    bun_bin=$(resolve_command "$bun_command")
  elif command -v bun >/dev/null 2>&1; then
    bun_bin=$(command -v bun)
  else
    bootstrap_bun
  fi
  check_bun_version
}

select_opencode() {
  if [ "${OPENCODE_SAFE_COMPACTION_OPENCODE+x}" = x ]; then
    opencode_bin=$(resolve_command "$opencode_command")
    return
  fi
  if command -v opencode >/dev/null 2>&1; then
    opencode_bin=$(command -v opencode)
    return
  fi
  if [ -n "${OPENCODE_INSTALL_DIR:-}" ] && [ -x "$OPENCODE_INSTALL_DIR/opencode" ]; then
    opencode_bin=$OPENCODE_INSTALL_DIR/opencode
    say "OpenCode not found on PATH; using $opencode_bin"
    return
  fi
  if [ -n "${XDG_BIN_DIR:-}" ] && [ -x "$XDG_BIN_DIR/opencode" ]; then
    opencode_bin=$XDG_BIN_DIR/opencode
    say "OpenCode not found on PATH; using $opencode_bin"
    return
  fi
  for candidate in \
    "$HOME/bin/opencode" \
    "$HOME/.opencode/bin/opencode" \
    "$HOME/.local/bin/opencode" \
    "$HOME/.bun/bin/opencode" \
    "$HOME/.local/share/pnpm/opencode" \
    "$HOME/.local/share/mise/shims/opencode" \
    "$HOME/.nix-profile/bin/opencode" \
    /opt/homebrew/bin/opencode \
    /home/linuxbrew/.linuxbrew/bin/opencode \
    /usr/local/bin/opencode \
    /usr/bin/opencode
  do
    if [ -x "$candidate" ]; then
      opencode_bin=$candidate
      say "OpenCode not found on PATH; using $opencode_bin"
      return
    fi
  done
  fail "OpenCode executable not found on PATH or in a supported install location; set OPENCODE_SAFE_COMPACTION_OPENCODE=/absolute/path/to/opencode"
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
case "$install_dir" in /) fail "install directory is unsafe: $install_dir" ;; esac
while [ "${install_dir%/}" != "$install_dir" ]; do install_dir=${install_dir%/}; done
case "$install_dir" in ""|/) fail "install directory is unsafe: $install_dir" ;; esac
[ "$install_dir" != "${HOME%/}" ] || fail "install directory is unsafe: $install_dir"
case "$config_dir" in /*) ;; *) fail "config directory must be absolute: $config_dir" ;; esac
case "$config_dir" in /) fail "config directory is unsafe: $config_dir" ;; esac
while [ "${config_dir%/}" != "$config_dir" ]; do config_dir=${config_dir%/}; done
case "$config_dir" in ""|/) fail "config directory is unsafe: $config_dir" ;; esac
reject_insecure_repository "$repository"

git_bin=$(resolve_command git)
select_opencode
check_opencode_version

temporary_root=${TMPDIR:-/tmp}
case "$temporary_root" in /*) ;; *) fail "temporary directory must be absolute: $temporary_root" ;; esac
transaction_dir=$(mktemp -d "$temporary_root/opencode-safe-compaction.XXXXXX") || fail "could not create transaction directory"
state_file=$transaction_dir/config-state.json
verification_config_dir=$transaction_dir/verify-config
transaction_active=1
checkout_changed=0
cloned_checkout=0
previous_head=
previous_branch=
checkout_lock=
config_lock=
checkout_lock_held=0
config_lock_held=0

finish() {
  status=$?
  trap - 0 1 2 15
  set +e
  rollback_failed=0
  config_rollback_failed=0
  if [ "$transaction_active" -eq 1 ] && [ "$status" -ne 0 ]; then
    if [ -f "$state_file" ]; then
      OPENCODE_SAFE_COMPACTION_ACTION=rollback \
      OPENCODE_SAFE_COMPACTION_STATE_FILE=$state_file \
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR=$config_dir \
      OPENCODE_SAFE_COMPACTION_DIR=$install_dir \
      OPENCODE_SAFE_COMPACTION_MODEL=$model \
      OPENCODE_SAFE_COMPACTION_MODEL_EXPLICIT=$model_explicit \
        "$bun_bin" "$install_dir/scripts/configure.ts" || {
          rollback_failed=1
          config_rollback_failed=1
        }
    fi
    if [ "$config_rollback_failed" -eq 0 ] && [ "$cloned_checkout" -eq 1 ]; then
      rm -rf -- "$install_dir" || rollback_failed=1
      say "rolled back the new checkout"
    elif [ "$config_rollback_failed" -eq 0 ] && [ "$checkout_changed" -eq 1 ]; then
      if [ -n "$previous_branch" ]; then
        "$git_bin" -C "$install_dir" checkout --quiet "$previous_branch" || rollback_failed=1
      else
        "$git_bin" -C "$install_dir" checkout --quiet --detach "$previous_head" || rollback_failed=1
      fi
      "$git_bin" -C "$install_dir" reset --hard "$previous_head" >/dev/null || rollback_failed=1
      say "rolled back the checkout to $previous_head"
    elif [ "$config_rollback_failed" -ne 0 ]; then
      say "preserved the checkout because configuration rollback was refused"
    fi
    if [ "$rollback_failed" -ne 0 ]; then
      printf 'opencode-safe-compaction: rollback was incomplete; inspect %s and %s\n' "$install_dir" "$config_dir" >&2
    fi
  fi
  if [ "$config_lock_held" -eq 1 ]; then rm -rf -- "$config_lock"; fi
  if [ "$checkout_lock_held" -eq 1 ]; then rm -rf -- "$checkout_lock"; fi
  rm -rf -- "$transaction_dir"
  exit "$status"
}

trap finish 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

select_bun

acquire_lock() {
  lock_target=$1
  lock_attempts=0
  until mkdir -m 700 "$lock_target" 2>/dev/null; do
    lock_pid=
    if [ -r "$lock_target/pid" ]; then read -r lock_pid < "$lock_target/pid" || lock_pid=; fi
    case "$lock_pid" in
      ""|*[!0-9]*) ;;
      *)
        if ! kill -0 "$lock_pid" 2>/dev/null; then
          rm -rf -- "$lock_target"
          continue
        fi
        ;;
    esac
    lock_attempts=$((lock_attempts + 1))
    [ "$lock_attempts" -lt 300 ] || fail "timed out waiting for installer lock: $lock_target"
    sleep 0.1
  done
  printf '%s\n' "$$" > "$lock_target/pid"
}

mkdir -p "$(dirname "$install_dir")" "$config_dir"
checkout_lock=$(dirname "$install_dir")/.opencode-safe-compaction-checkout.lock
config_lock=$config_dir/.opencode-safe-compaction-install.lock
acquire_lock "$checkout_lock"
checkout_lock_held=1
acquire_lock "$config_lock"
config_lock_held=1

commit_ref=0
if [ "${#ref}" -eq 40 ]; then
  case "$ref" in
    *[!0-9a-f]*) ;;
    *) commit_ref=1 ;;
  esac
fi
if [ "$commit_ref" -eq 0 ]; then
  "$git_bin" check-ref-format --branch "$ref" >/dev/null 2>&1 || fail "invalid Git branch: $ref"
fi

if [ -e "$install_dir" ]; then
  [ -d "$install_dir/.git" ] || fail "install path exists but is not a Git checkout: $install_dir"
  actual_repository=$("$git_bin" -C "$install_dir" remote get-url origin 2>/dev/null) ||
    fail "existing checkout has no origin remote: $install_dir"
  reject_insecure_repository "$actual_repository"
  [ "$(canonical_repository "$actual_repository")" = "$(canonical_repository "$repository")" ] ||
    fail "existing checkout origin does not match $repository"
  [ -z "$("$git_bin" -C "$install_dir" status --porcelain --untracked-files=normal)" ] ||
    fail "existing checkout has local changes; commit, stash, or remove them before updating"
  previous_branch=$("$git_bin" -C "$install_dir" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
  if [ "$commit_ref" -eq 0 ]; then
    [ -n "$previous_branch" ] || fail "existing checkout is detached; check out $ref before updating"
    [ "$previous_branch" = "$ref" ] || fail "existing checkout is on $previous_branch, expected $ref"
  fi
  previous_head=$("$git_bin" -C "$install_dir" rev-parse HEAD)
  checkout_changed=1
  say "updating $install_dir"
  if [ "$commit_ref" -eq 1 ]; then
    "$git_bin" -C "$install_dir" fetch --depth 1 origin "$ref"
    [ "$("$git_bin" -C "$install_dir" rev-parse FETCH_HEAD)" = "$ref" ] || fail "repository did not return pinned commit $ref"
    "$git_bin" -C "$install_dir" checkout --quiet --detach FETCH_HEAD
  else
    "$git_bin" -C "$install_dir" fetch origin "$ref"
    "$git_bin" -C "$install_dir" merge --ff-only FETCH_HEAD
  fi
else
  say "cloning $repository into $install_dir"
  mkdir -p "$(dirname "$install_dir")"
  cloned_checkout=1
  if [ "$commit_ref" -eq 1 ]; then
    "$git_bin" init --quiet "$install_dir"
    "$git_bin" -C "$install_dir" remote add origin "$repository"
    "$git_bin" -C "$install_dir" fetch --depth 1 origin "$ref"
    [ "$("$git_bin" -C "$install_dir" rev-parse FETCH_HEAD)" = "$ref" ] || fail "repository did not return pinned commit $ref"
    "$git_bin" -C "$install_dir" checkout --quiet --detach FETCH_HEAD
  else
    "$git_bin" clone --branch "$ref" --depth 1 -- "$repository" "$install_dir"
  fi
fi

OPENCODE_SAFE_COMPACTION_STATE_FILE=$state_file \
OPENCODE_SAFE_COMPACTION_CONFIG_DIR=$config_dir \
OPENCODE_SAFE_COMPACTION_DIR=$install_dir \
OPENCODE_SAFE_COMPACTION_MODEL=$model \
OPENCODE_SAFE_COMPACTION_MODEL_EXPLICIT=$model_explicit \
OPENCODE_SAFE_COMPACTION_VERIFY_DIR=$verification_config_dir \
  "$bun_bin" "$install_dir/scripts/configure.ts"
[ -r "$verification_config_dir/model" ] || fail "plugin configuration did not report its effective model"
IFS= read -r model < "$verification_config_dir/model" || fail "could not read the effective compaction model"

say "verifying the installed plugin in isolation"
mkdir -p \
  "$transaction_dir/home" \
  "$transaction_dir/xdg-config" \
  "$transaction_dir/target-xdg" \
  "$transaction_dir/xdg-data" \
  "$transaction_dir/xdg-cache" \
  "$transaction_dir/xdg-state"
ln -s "$config_dir" "$transaction_dir/target-xdg/opencode"
debug_config() {
  debug_phase=$1
  if [ "$debug_phase" = "isolated" ]; then
    debug_xdg_config=$transaction_dir/xdg-config
    debug_config_dir=$verification_config_dir
  else
    debug_xdg_config=$transaction_dir/target-xdg
    debug_config_dir=
  fi
  HOME="$transaction_dir/home" \
  XDG_CONFIG_HOME="$debug_xdg_config" \
  XDG_DATA_HOME="$transaction_dir/xdg-data" \
  XDG_CACHE_HOME="$transaction_dir/xdg-cache" \
  XDG_STATE_HOME="$transaction_dir/xdg-state" \
  OPENCODE_SAFE_COMPACTION_DIR="$install_dir" \
  OPENCODE_SAFE_COMPACTION_MODEL="$model" \
  OPENCODE_SAFE_COMPACTION_MODEL_EXPLICIT="$model_explicit" \
  OPENCODE_SAFE_COMPACTION_VERIFY_PHASE="$debug_phase" \
  OPENCODE_CONFIG= \
  OPENCODE_CONFIG_CONTENT= \
  OPENCODE_CONFIG_DIR="$debug_config_dir" \
  OPENCODE_DISABLE_PROJECT_CONFIG=true \
  OPENCODE_DISABLE_MODELS_FETCH=1 \
  OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
  OPENCODE_PURE=0 \
  "$opencode_bin" debug config
}

verify_debug_output() {
  verify_phase=$1
  verify_output=$2
  printf '%s' "$verify_output" | \
    OPENCODE_SAFE_COMPACTION_ACTION=verify \
    OPENCODE_SAFE_COMPACTION_VERIFY_PHASE=$verify_phase \
    OPENCODE_SAFE_COMPACTION_VERIFY_DIR=$verification_config_dir \
    OPENCODE_SAFE_COMPACTION_CONFIG_DIR=$config_dir \
    OPENCODE_SAFE_COMPACTION_DIR=$install_dir \
    OPENCODE_SAFE_COMPACTION_MODEL=$model \
    OPENCODE_SAFE_COMPACTION_MODEL_EXPLICIT=$model_explicit \
    "$bun_bin" "$install_dir/scripts/configure.ts" >/dev/null
}

debug_output=$(debug_config isolated) || fail "OpenCode could not load the isolated plugin configuration"
verify_debug_output isolated "$debug_output" || fail "OpenCode loaded the isolated configuration but did not activate the plugin config hook"

say "verifying compatibility with the target OpenCode configuration"
debug_output=$(debug_config target) || fail "OpenCode could not load the installed configuration"
verify_debug_output target "$debug_output" || fail "OpenCode loaded the configuration but did not activate the plugin config hook"

OPENCODE_SAFE_COMPACTION_ACTION=commit \
OPENCODE_SAFE_COMPACTION_STATE_FILE=$state_file \
OPENCODE_SAFE_COMPACTION_CONFIG_DIR=$config_dir \
OPENCODE_SAFE_COMPACTION_DIR=$install_dir \
OPENCODE_SAFE_COMPACTION_MODEL=$model \
OPENCODE_SAFE_COMPACTION_MODEL_EXPLICIT=$model_explicit \
  "$bun_bin" "$install_dir/scripts/configure.ts"
transaction_active=0

install_cli_wrapper() {
  persistent_bun=$(command -v "$bun_command" 2>/dev/null || true)
  [ -n "$persistent_bun" ] || return 0
  cli_bin_dir=${OPENCODE_SAFE_COMPACTION_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}
  case "$cli_bin_dir" in /*) ;; *) say "skipping CLI wrapper; bin directory is not absolute: $cli_bin_dir"; return 0 ;; esac
  if ! mkdir -p "$cli_bin_dir" 2>/dev/null; then
    say "skipping CLI wrapper; bin directory is not writable: $cli_bin_dir"
    return 0
  fi
  if [ ! -w "$cli_bin_dir" ]; then
    say "skipping CLI wrapper; bin directory is not writable: $cli_bin_dir"
    return 0
  fi
  cli_wrapper=$cli_bin_dir/better-compact
  cli_temp=$cli_wrapper.tmp.$$
  fallback_install_dir=$HOME/.local/share/opencode/plugins/safe-compaction
  printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    "cli=\"$install_dir/scripts/cli.ts\"" \
    "if [ ! -f \"\$cli\" ] && [ -f \"$fallback_install_dir/scripts/cli.ts\" ]; then cli=\"$fallback_install_dir/scripts/cli.ts\"; fi" \
    "if [ ! -f \"\$cli\" ]; then echo \"better-compact: installed CLI source is missing; rerun the installer\" >&2; exit 1; fi" \
    "exec \"$persistent_bun\" \"\$cli\" \"\$@\"" > "$cli_temp"
  chmod 755 "$cli_temp"
  mv -f "$cli_temp" "$cli_wrapper"
  say "installed CLI at $cli_wrapper"
}

install_cli_wrapper

say "installed successfully"
say "restart any running OpenCode server before using the plugin"
