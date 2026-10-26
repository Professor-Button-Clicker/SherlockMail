---
colors:
  paper: "#EEF1EC"
  sheet: "#FFFFFF"
  print: "#1D2329"
  rule: "#AEB7AC"
  ink: "#2342A6"
  stamp: "#1D6B44"
  alert: "#B42318"
  canary: "#F1CE45"
  dark:
    paper: "#15181C"
    sheet: "#1C2025"
    print: "#E3E7EC"
    rule: "#454D57"
    ink: "#9DB2FF"
    stamp: "#62CC93"
    alert: "#FF7A70"
    canary: "#E6C443"
typography:
  sans: "Archivo Variable (bundled, wdth 62-125, wght 100-900)"
  mono: "IBM Plex Mono (bundled, 400/500)"
  sizes: [12, 13, 14, 16, 20, 26, 34]
rounded: "4px"
spacing: "4px"
components: [case-tag, custody-stamp, project-register, form-field, choice-card, button, ruled-table, tally, wizard-step, status-chip, toast]
---

# SherlockMail design language: "Custody form"

SherlockMail produces evidence. Its look comes from the paperwork that travels with evidence, not
from a generic dark dashboard: chain-of-custody forms, evidence tags, carbonless triplicate copies,
ballpoint ink and tamper seals.

## Colour roles

Each colour has one job, so colour itself carries meaning.

| Token | Role |
|-------|------|
| `paper` / `sheet` | The desk and the form sheet. Cool grey-green, never cream. |
| `print` | Everything SherlockMail itself prints: labels, headings, navigation. |
| `ink` | What people act on and what was captured from evidence: primary actions, links, and values typed into fields. Like ballpoint on a printed form. |
| `stamp` | Done and verified: a completed custody step, a passed check, a verified hash. Rubber-stamp green, because red would read as failure. |
| `alert` | Failures and destructive actions only. |
| `canary` | The yellow carbon copy: highlights, warnings, "needs attention". Used as a stripe or a marker, never as text colour. |
| `rule` | Form lines and borders. |

## Type

- Archivo carries the interface. Headings use its semi-expanded width (`font-stretch: 112%`) at
  weight 640, like the printed headings of a government form. Body text is normal width at 400.
- IBM Plex Mono is only for literal evidence data: hashes, paths, message IDs, server addresses.
- Numbers in tables and counters use tabular figures.
- Labels are sentence case. No tracked all-caps eyebrows.

## The one bold element

The **case tag** at the top of every case screen: an evidence tag with a punched eyelet, the case's
key fields laid out as form boxes, and the custody sequence (Opened, Collected, Checked, Exported).
Each step that has happened carries a circular date stamp in stamp green; the next step is the single
ink-blue action (hidden on the screen it would open). Everything else stays quiet.

## Workflow

- The navigation lists the open project's steps in their real order (Collect, Review, Quality check,
  Export), numbered because they are a sequence; a completed step's number fills in.
- The top bar always names the open project; it is also the way to switch projects.
- Field errors appear under the field and are announced; toasts are for confirmations and are
  announced as status (errors as alerts).
- Choice cards keep their real checkbox or radio, so they work from the keyboard.
- Fonts are bundled with the app: a forensic workstation should not call out to a font CDN.

## Rules

- Corners: 4px on controls, 6px on panels. No pill buttons except status chips.
- Shadows: none on cards; separation comes from `rule` lines and `sheet` against `paper`.
  Only floating layers (toasts, menus, dialogs) get a shadow.
- No gradients, no glows, no emoji as icons.
- Motion: 150-220 ms ease-out, transform and opacity only, and `prefers-reduced-motion` respected.
- Focus: a 2px ink outline offset by 2px on every interactive element.
- Status is never colour alone: chips carry a word, stamps carry a date.
- Tallies (counts and totals) sit in ruled boxes of one form, not in floating stat cards.
- Contrast: body text 4.5:1 or better on its surface; muted text too.
