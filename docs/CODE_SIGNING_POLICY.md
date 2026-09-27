# Potato Code Signing Policy

Status: planned / intended. Potato has not been approved by SignPath Foundation, and this repository does not claim that a Potato 1.0.0 binary is currently signed.

The intended service disclosure is included because the SignPath Foundation open-source conditions require it on the project home page and download/release pages:

> Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

The sentence above describes the intended application and is not evidence that the application has been accepted or that a signing request has completed.

## Scope

- The official Potato 1.0.0 Desktop binary distribution is Windows x64 only.
- macOS and Linux source/build support remains in the repository, but no official macOS or Linux binary is distributed in 1.0.0.
- Android is a separate Potato mobile client and is not built by the Desktop GitHub Release workflow.

## Intended signing controls

After Potato receives its own SignPath project and is approved for the intended service, the release workflow will:

1. build the unpacked Windows application from this repository on a GitHub-hosted runner;
2. submit only the unpacked `application/Potato.exe` input for application signing;
3. verify the returned Authenticode signature and timestamp before packaging;
4. build the NSIS installer and portable executable from those signed application bytes;
5. submit the installer and portable executable as separate exact paths for release signing;
6. regenerate `latest.yml` and the installer blockmap after the signed bytes are returned;
7. verify the publisher, Authenticode status, and timestamp for every public Windows executable; and
8. stage only the final verified Windows files for the GitHub Release.

Missing Potato SignPath configuration fails the workflow before any signing request. The workflow has no fallback to the upstream SignPath organization, project, policy, or artifact configuration.

## Potato project configuration

The actual organization ID, project slug, signing-policy slug, artifact-configuration slugs, and API token are intentionally not stored in this repository. The workflow requires these repository settings:

- Secret: `TOKEN_M_SIGNPATH_API_TOKEN`
- Variable: `TOKEN_M_SIGNPATH_ORGANIZATION_ID`
- Variable: `TOKEN_M_SIGNPATH_PROJECT_SLUG`
- Variable: `TOKEN_M_SIGNPATH_SIGNING_POLICY_SLUG`
- Variable: `TOKEN_M_SIGNPATH_APPLICATION_ARTIFACT_CONFIGURATION_SLUG`
- Variable: `TOKEN_M_SIGNPATH_RELEASE_ARTIFACT_CONFIGURATION_SLUG`

The Potato SignPath project must create these two logical artifact configurations. Their actual SignPath slugs are supplied through the variables above rather than invented in source control:

### Potato Windows Application

The configuration signs exactly `application/Potato.exe` and enforces product name `Potato` and the submitted version. The version-controlled definition is `.github/signpath/application-artifact-configuration.xml`.

### Potato Windows Release Artifacts

The configuration signs exactly:

- `installer/Potato-Setup-${version}.exe`
- `portable/Potato-${version}.exe`

It enforces product name `Potato` and the submitted version for both PE files. The version-controlled definition is `.github/signpath/artifact-configuration.xml`.

The SignPath project should use GitHub as a trusted build system, enable origin verification for the release policy, restrict the policy to the Potato release branch pattern, and require manual approval for every production signing request.

## Team roles and account controls

- Authors / maintainers: [@Gary06910](https://github.com/Gary06910), the current Potato repository owner and maintainer.
- Reviewers: [@Gary06910](https://github.com/Gary06910) reviews changes proposed by non-committers; any future delegated reviewer must be recorded in this policy before use.
- Approvers: [@Gary06910](https://github.com/Gary06910) is the intended manual release-signing approver; a successful CI submission is not approval.

Everyone with GitHub or SignPath access used for this project must enable multi-factor authentication before the Foundation application and must review workflow files, build scripts, and makefiles as part of source review.

## Privacy and user controls

Potato is not a pure offline application. Usage logs and local usage statistics are processed on the device. GitHub is used for update checks. When the user explicitly enables and pairs Potato notifications, the Desktop sends the allowlisted completion event to the user-configured Potato backend / uniCloud for delivery to Android. The current Android system notification uses generic completion text and task identity; prompt text, reply text, absolute `cwd`, terminal output, source code, and file contents are not included in that system notification. See the [Potato privacy policy](privacy.md).

The Windows installer provides an uninstaller. Removing the application does not silently delete `%APPDATA%\Token Monitor`, which contains user settings, credentials, usage history, pairing data, and notification outbox data; users may remove that data separately when they intend to do so.

## Download verification

For an approved signed release, Windows Explorer should report a valid Digital Signature from SignPath Foundation for `Potato-Setup-<version>.exe`, `Potato-<version>.exe`, and the installed `Potato.exe`. PowerShell can be used to inspect the status and timestamp:

```powershell
Get-AuthenticodeSignature ".\Potato-Setup-<version>.exe", ".\Potato-<version>.exe" |
  Format-List Path, Status, SignerCertificate, TimeStamperCertificate
```
