#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?Run this script on a temporary CI runner}"
: "${HARMONY_OHPM_PRIVATE_KEY:?Missing OHPM private key}"
: "${HARMONY_OHPM_KEY_PASSPHRASE:?Missing OHPM key passphrase}"
: "${HARMONY_OHPM_PUBLISH_ID:?Missing OHPM publish ID}"

umask 077
credentials_dir="$(mktemp -d "$RUNNER_TEMP/harmony-ohpm.XXXXXX")"
cleanup() {
    for key in key_path publish_id crypto_path key_passphrase; do
        ohpm config delete "$key" >/dev/null 2>&1 || true
    done
    rm -rf "$credentials_dir"
}
trap cleanup EXIT

printf '%s\n' "$HARMONY_OHPM_PRIVATE_KEY" > "$credentials_dir/id_harmony"
openssl pkey -in "$credentials_dir/id_harmony" \
    -passin env:HARMONY_OHPM_KEY_PASSPHRASE -noout
export OHPM_CRYPTO_PATH="$credentials_dir/crypto"

# OHPM's password reader requires a terminal and ignores input chunks containing
# control characters. Type through a PTY, with the final Enter sent separately.
encrypted_passphrase="$(expect <<'EXPECT'
log_user 0
set timeout 30
set send_slow {1 0.01}
spawn ohpm config encrypt --crypto_path $env(OHPM_CRYPTO_PATH)
expect {
    "Please enter the password to be encrypted:" {
        send -s -- "$env(HARMONY_OHPM_KEY_PASSPHRASE)\r"
    }
    timeout { exit 1 }
    eof { exit 1 }
}
expect {
    -re {security:[0-9]+:[^\r\n]+} { set encrypted $expect_out(0,string) }
    timeout { exit 1 }
    eof { exit 1 }
}
expect {
    eof {}
    timeout { exit 1 }
}
set result [wait]
if {[lindex $result 3] != 0} { exit 1 }
puts $encrypted
EXPECT
)"
test -n "$encrypted_passphrase"
printf '::add-mask::%s\n' "$encrypted_passphrase"
ohpm config set key_path "$credentials_dir/id_harmony"
ohpm config set publish_id "$HARMONY_OHPM_PUBLISH_ID"
ohpm config set crypto_path "$OHPM_CRYPTO_PATH"
ohpm config set key_passphrase "$encrypted_passphrase"
ohpm config set publish_registry https://ohpm.openharmony.cn/ohpm/

if [[ "${HARMONY_OHPM_DRY_RUN:-false}" == "true" ]]; then
    echo 'Harmony publish dry run: private key, passphrase and OHPM configuration validated; no packages uploaded.'
else
    bash "${HARMONY_UPLOAD_SCRIPT:-$(dirname "$0")/../upload.sh}"
fi
