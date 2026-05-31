# Markdown renderer regression

## Images

![Alt text](https://picsum.photos/seed/beautiful-md/320/180 "Optional title")

![Relative placeholder](./assets/sample.png)

## Highlight

Plain ==highlighted text== and ==with=equals inside==.

HTML <mark>mark tag</mark> should match theme highlight.

## Subscript / superscript

Water: H~2~O. Squared: x^2^.

Strikethrough: ~~deleted~~ (double tilde only).

## Emoji shortcodes

:rocket: :white_check_mark: :warning: :smile: :heart:

## RTL

Arabic: مرحبا بالعالم

Mixed LTR start — مرحبا — LTR end.

## Sanity (must stay working)

# Heading

- bullet
- [ ] task
- [x] done

> blockquote

`inline code`

```js
const ok = true;
```

| A | B |
|---|---|
| 1 | 2 |

Footnote[^1].

[^1]: note

Inline $E=mc^2$ and bare https://example.com

```mermaid
flowchart LR
  A --> B
```

<details><summary>Fold</summary>Body</details>

<kbd>Cmd</kbd>
