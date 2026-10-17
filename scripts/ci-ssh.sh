#!/usr/bin/env bash
# The deploy workflow's ssh setup: <user@host> <known_hosts lines> <private key>. Known hosts only and that key
# only; the host without its user goes to the step's output for Tailscale's ping.
set -euo pipefail
host=$1 known=$2 key=$3
if [[ -z $host || -z $known || -z $key ]]; then
  echo "::error::the production environment needs the variables DEPLOY_HOST and DEPLOY_KNOWN_HOSTS and the secret DEPLOY_SSH_KEY" >&2
  exit 1
fi
install -d -m 700 ~/.ssh
printf '%s\n' "$known" >~/.ssh/known_hosts
cat >~/.ssh/config <<'END'
Host *
  StrictHostKeyChecking yes
  UserKnownHostsFile ~/.ssh/known_hosts
  IdentityFile ~/.ssh/deploy_key
  IdentitiesOnly yes
END
(umask 077 && printf '%s\n' "$key" >~/.ssh/deploy_key)
host=${host#*@}
echo "host=${host%%:*}" >>"${GITHUB_OUTPUT:-/dev/null}"
