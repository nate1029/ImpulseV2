#!/usr/bin/env bash
# Turn on Google or GitHub sign-in for the deployed Impulse Cloud.
#
#   1. Create the OAuth app (DEPLOY.md step 8) and copy its client secret.
#   2. Run, from the repository folder:
#        cloud/scripts/set-signin.sh github <client-id>
#        cloud/scripts/set-signin.sh google <client-id>
#
# The secret is read from the clipboard (macOS pbpaste), so it never appears
# on screen or in the shell history; the clipboard is cleared afterwards.
# PROJECT, REGION, SERVICE and RUNTIME_SA can be overridden from the environment.
set -euo pipefail

provider="${1:-}"
client_id="${2:-}"
PROJECT="${PROJECT:-impulse-cloud-prod}"
REGION="${REGION:-us-west1}"
SERVICE="${SERVICE:-impulse-cloud}"
RUNTIME_SA="${RUNTIME_SA:-impulse-cloud@${PROJECT}.iam.gserviceaccount.com}"

case "$provider" in
  github | google) ;;
  *) echo "usage: $0 github|google <client-id>" >&2; exit 2 ;;
esac
if [ -z "$client_id" ]; then
  echo "usage: $0 $provider <client-id>" >&2
  exit 2
fi

secret_name="impulse-${provider}-secret"
upper="$(printf '%s' "$provider" | tr '[:lower:]' '[:upper:]')"
value="$(pbpaste)"
if [ "${#value}" -lt 20 ] || [ "${#value}" -gt 200 ] || printf '%s' "$value" | grep -q '[[:space:]]'; then
  echo "The clipboard does not hold a client secret. Copy it from the OAuth app's page, then run this again." >&2
  exit 1
fi

if gcloud secrets describe "$secret_name" --project "$PROJECT" >/dev/null 2>&1; then
  printf '%s' "$value" | gcloud secrets versions add "$secret_name" --project "$PROJECT" --data-file=- >/dev/null
else
  printf '%s' "$value" | gcloud secrets create "$secret_name" --project "$PROJECT" --data-file=- >/dev/null
fi
unset value
printf '' | pbcopy
echo "Stored the ${provider} client secret in Secret Manager (${secret_name}) and cleared the clipboard."

gcloud secrets add-iam-policy-binding "$secret_name" --project "$PROJECT" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --quiet \
  --update-env-vars "${upper}_CLIENT_ID=${client_id}" \
  --update-secrets "${upper}_CLIENT_SECRET=${secret_name}:latest"

url="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo "Sign-in methods the server now offers:"
curl -s "${url}/v1/config"
echo
