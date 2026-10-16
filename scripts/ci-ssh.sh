#!/usr/bin/env bash
# The deploy workflow's ssh setup: <user@host> <known_hosts lines> [<private key>]. Known hosts only, the key
# (when there is one) for every host; the host without its user goes to the step's output for Tailscale's ping.
set -euo pipefail
host=$1 known=$2 key=${3:-}
if [[ -z $host || -z $known ]]; then
  echo "::error::this environment needs the variables DEPLOY_HOST and DEPLOY_KNOWN_HOSTS" >&2
  exit 1
fi
install -d -m 700 ~/.ssh
printf '%s\n' "$known" >~/.ssh/known_hosts
{
  echo "Host *"
  echo "  StrictHostKeyChecking yes"
  echo "  UserKnownHostsFile ~/.ssh/known_hosts"
  if [[ -n $key ]]; then
    echo "  IdentityFile ~/.ssh/deploy_key"
    echo "  IdentitiesOnly yes"
  fi
} >~/.ssh/config
if [[ -n $key ]]; then
  (umask 077 && printf '%s\n' "$key" >~/.ssh/deploy_key)
fi
host=${host#*@}
echo "host=${host%%:*}" >>"${GITHUB_OUTPUT:-/dev/null}"
