# Interface localization

Interface language is independent of translation source/target languages. The only
persisted value is `ui.locale.v1` (`auto` or a code from `LOCALES`). UI changes never
send `save`, `toggle`, or `settings-updated` messages.

- `locale.ts`: supported languages and browser-language matching.
- `text.ts`: pure render-time translation, number/date/plural formatting, and safe
  display of known messages. Pure modules and Node tests import this file.
- `index.ts`: browser storage, root-scoped direction, and explicitly annotated DOM
  nodes. Pass a shadow root or extension-owned element for injected controls; never
  initialize the host website's document.
- `wire.ts`: serializable `{ id, params }` display messages. Existing machine error
  strings stay available to business logic. Unknown external error bodies are not
  rendered directly.
- `*-messages.json`: source messages; `locales`: complete offline catalogs;
  `counts`: explicit plural forms; `overrides`: reviewed wording corrections.

Stable extracted IDs are `m_` plus the first twelve hexadecimal SHA-256 characters
of the trimmed Chinese source. New features may use descriptive stable IDs. Keep
named parameters identical across translations, and pass user/model/source text
as text parameters rather than HTML. Do not localize machine IDs, input values,
test corpora, or translated user content.

After changing source text, run `node scripts/i18n-catalog.mjs`, supply translations
for every locale, then run `node scripts/i18n-build.mjs`. The latter applies reviewed
overrides, validates catalogs, and generates Chrome `_locales` metadata. These
commands are offline; no translation service or developer credential is needed
to build or run the extension.

Use `bindLocalizedText`/`bindLocalizedAttribute` for render-time expressions, or
subscribe a state-only renderer with `onLocaleChange`. Do not reload the form or
reissue actions on a language change. Dispose subscriptions with their UI roots.
Static markup uses `data-i18n`, `data-i18n-title`, `data-i18n-placeholder`, and
`data-i18n-aria-label`. Mark only leaf text nodes so localization preserves controls.

Verification: `test/ui/i18n.test.mjs` checks catalog parameters, matching, plural
forms, storage races and root isolation. `scripts/verify-i18n.mjs` exercises the
built extension in an isolated browser with offline provider fixtures.
