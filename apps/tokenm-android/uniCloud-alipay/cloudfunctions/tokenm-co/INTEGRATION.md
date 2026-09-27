# Official integration boundary

This Cloud Object requires the official `uni-id-common` common module and the local `tokenm-core` common module. In HBuilderX, use **Manage common module dependencies** on `tokenm-co`; do not copy either official `uni-id-common` or `uni-id-co` source into this directory.

Authentication is performed only by `uni-id-common.createInstance({ clientInfo })` followed by `checkToken(this.getUniIdToken())`. Potato uses only the returned `uid` as the business owner. Username/password registration, login, token lifecycle, captcha, account closure, and `setPushCid` remain official `uni-id-co` responsibilities.

Before isolated-space validation, configure a single 32-byte base64url value named `TOKEN_M_DESKTOP_CREDENTIAL_KEY` in the uniCloud environment-variable UI. This repository contains no key, SpaceID binding, uni-push credential, or deployment command.

Account deletion is deliberately two-stage. The client must call Potato `deleteAccount` repeatedly until `cleanupPending` is `false`; only then may it invoke the current official `uniIdCo.closeAccount()` API. Potato deletes only its six custom collections and never writes or deletes official identity records. The official method name was verified against the DCloud `uni-id-co` documentation on 2026-08-23; the installed official module version must still be checked during isolated-space integration.
