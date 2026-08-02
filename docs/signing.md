# Code signing and download verification

Lineage's installers are currently **unsigned**. This page says exactly what that
means for you as a user, what it costs to fix, and how to verify a download in
the meantime.

## What "unsigned" costs a user

| Platform | What happens |
|---|---|
| **Windows** | SmartScreen shows *"Windows protected your PC"*. The installer runs via **More info → Run anyway**. The warning fades as a signed app accumulates reputation; an unsigned one warns forever. |
| **macOS** | Gatekeeper refuses on double-click. Open with **right-click → Open**, then confirm — or clear the quarantine flag: `xattr -dr com.apple.quarantine /Applications/Lineage.app` |
| **Linux** | No effect. `.deb` and `.AppImage` are not code-signed by convention; the checksums below are the normal verification. |

## Verify a download today

Every release publishes `SHA256SUMS-<platform>.txt`. Compare the hash of what you
downloaded against it:

```bash
# macOS / Linux
shasum -a 256 Lineage-1.0.1-arm64.dmg
# Windows (PowerShell)
Get-FileHash .\Lineage-1.0.1-portable.exe -Algorithm SHA256
```

Builds also carry **provenance attestation**, which is stronger than a checksum:
it proves cryptographically that the file was produced by this repository's
release workflow, from a specific commit, on GitHub's runners — not by someone
who merely re-uploaded a file with a matching hash.

```bash
gh attestation verify Lineage-1.0.1-arm64.dmg --repo darktw1nk/Lineage
```

Attestation does **not** silence SmartScreen or Gatekeeper. Those check for a
certificate from a recognised authority, which is a separate thing that must be
bought.

## Enabling signing

The release workflow already reads the certificates. Add the secrets and the next
tagged build signs itself — **no workflow change, no code change**. Without them
it stays unsigned rather than failing.

### Windows — ~$200–500/year

An OV or EV certificate from a CA (DigiCert, Sectigo, SSL.com). Requires business
identity verification; EV additionally ships on a hardware token, which
complicates CI and usually means a cloud signing service. OV is the practical
choice for CI.

Convert the `.pfx` to base64 and add these repository secrets:

```bash
base64 -w0 certificate.pfx > cert.txt   # macOS: base64 -i certificate.pfx
```

| Secret | Value |
|---|---|
| `WINDOWS_CERT_BASE64` | contents of `cert.txt` |
| `WINDOWS_CERT_PASSWORD` | the `.pfx` password |

### macOS — $99/year

Apple Developer Program membership. Create a **Developer ID Application**
certificate, export it as `.p12`, and base64 it the same way.

| Secret | Value |
|---|---|
| `MACOS_CERT_BASE64` | base64 of the `.p12` |
| `MACOS_CERT_PASSWORD` | the `.p12` password |

Signing alone still leaves a Gatekeeper prompt. **Notarisation** removes it, and
needs three more secrets:

| Secret | Value |
|---|---|
| `APPLE_ID` | the Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | from appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | the 10-character team ID from developer.apple.com → Membership |

### Verifying it worked

The build log prints `signing enabled: true|false`. After a signed release:

```bash
# Windows
signtool verify /pa /v "Lineage Setup 1.0.1.exe"
# macOS — the second command is the one that proves notarisation
codesign -dv --verbose=4 /Applications/Lineage.app
spctl -a -vvv -t install /Applications/Lineage.app
```

## Why this is not done already

Certificates are tied to a verified legal identity and a payment method. They
cannot be provisioned from a repository, which is why the pipeline is built to
accept them rather than to assume them.
