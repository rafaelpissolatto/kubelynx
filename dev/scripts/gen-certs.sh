#!/usr/bin/env bash
# Creates a local CA and a server certificate for the gateway's *.localhost
# hostnames. Idempotent: an existing CA is kept (so a CA you've already
# trusted stays valid); the server cert is reissued only when missing, when
# HOSTNAMES changes, or when it no longer verifies against the CA.
#
#   CERT_DIR  server cert/key (tls.crt, tls.key), default dev/gateway/certs
#   CA_DIR    CA cert/key (ca.crt, ca.key), default CERT_DIR. Point it at a CA
#             you already trust, e.g. the OpenObserve lab's gateway/certs, to
#             skip trusting a second one.
#
# Trust $CA_DIR/ca.crt once (`make trust-ca-windows`, `make trust-ca-wsl`)
# and every certificate issued here shows as valid in the browser.
set -euo pipefail

DIR="${CERT_DIR:-dev/gateway/certs}"
CA_DIR="${CA_DIR:-$DIR}"
# Explicit names plus a wildcard: browsers don't all honour a wildcard
# directly under a top-level domain like "localhost", so the known
# hostnames are listed too.
HOSTNAMES="${HOSTNAMES:-kubelynx.localhost prometheus.localhost demo.localhost mesh.localhost *.localhost localhost}"

SAN=$(set -f; for h in $HOSTNAMES; do printf 'DNS:%s,' "$h"; done)
SAN="${SAN}IP:127.0.0.1"

# A CA_DIR other than CERT_DIR is a CA you already trust: it's only read,
# never created or overwritten, so a typo or a folder with just ca.crt
# fails instead of silently replacing that CA.
if [[ "$CA_DIR" != "$DIR" && ! ( -f "$CA_DIR/ca.crt" && -f "$CA_DIR/ca.key" ) ]]; then
  echo "CA_DIR=$CA_DIR must contain ca.crt and ca.key; it is only read, never written." >&2
  exit 1
fi
mkdir -p "$DIR"
CA_CRT="$(cd "$CA_DIR" && pwd)/ca.crt"
CA_KEY="$(cd "$CA_DIR" && pwd)/ca.key"

# A valid cert for the same names is kept, whichever CA signed it: a cert
# issued from a reused CA_DIR stays put on a later run with the default
# CA_DIR, which has that CA's ca.crt but not its key.
up_to_date() {
  [[ -f "$DIR/tls.crt" && -f "$DIR/tls.san" && -f "$DIR/ca.crt" ]] &&
    [[ "$(cat "$DIR/tls.san")" == "$SAN" ]] &&
    openssl verify -CAfile "$DIR/ca.crt" "$DIR/tls.crt" >/dev/null 2>&1 &&
    { [[ ! -f "$CA_KEY" ]] || cmp -s "$CA_CRT" "$DIR/ca.crt"; }
}
if up_to_date; then
  echo "Server certificate up to date ($DIR/tls.crt)."
  exit 0
fi

if [[ ! -f "$CA_KEY" || ! -f "$CA_CRT" ]]; then
  echo "Creating local CA ($CA_CRT)..."
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$CA_KEY" -out "$CA_CRT" \
    -subj "/CN=KubeLynx dev local CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "nameConstraints=critical,permitted;DNS:localhost,permitted;IP:127.0.0.1/255.255.255.255" 2>/dev/null
  chmod 600 "$CA_KEY"
fi

cd "$DIR"
# The CA the gateway's chain must verify against, for `make test` and the
# trust targets, whichever CA_DIR it came from.
[[ "$CA_CRT" == "$(pwd)/ca.crt" ]] || cp "$CA_CRT" ca.crt

echo "Issuing server certificate for: $HOSTNAMES"
openssl req -newkey rsa:2048 -nodes -keyout tls.key -out tls.csr \
  -subj "/CN=kubelynx.localhost" 2>/dev/null
# 825 days is the longest validity Apple platforms accept for TLS server certs.
# -CAserial in $DIR so a shared CA_DIR isn't written to.
openssl x509 -req -in tls.csr -CA "$CA_CRT" -CAkey "$CA_KEY" \
  -CAserial ca.srl -CAcreateserial \
  -out tls.crt -days 825 -sha256 \
  -extfile <(printf '%s\n' \
    "basicConstraints=CA:FALSE" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth" \
    "subjectAltName=$SAN") 2>/dev/null
rm -f tls.csr
chmod 600 tls.key
printf '%s' "$SAN" >tls.san
openssl verify -CAfile ca.crt tls.crt
