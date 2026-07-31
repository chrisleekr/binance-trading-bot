# Correct card grids

A complex grid: `-` plus three spaces, body indented four.

<div class="grid cards" markdown>

-   :material-play-circle:{ .lg .middle } **[One](one.md)**

    ---

    Body text that belongs inside the card, wrapped over
    two source lines.

-   :material-book-open-variant:{ .lg .middle } **[Two](two.md)**

    ---

    Second card.

</div>

A simple grid: one line per card, no body to indent.

<div class="grid cards" markdown>

- **HTML** for content and structure
- **CSS** for presentation

</div>

A card with several body paragraphs, all at four.

<div class="grid cards" markdown>

-   **[Three](three.md)**

    ---

    Intro line.

    Closing line, still at four.

</div>

A grid nested inside an admonition, so its cards sit at four columns and its
bodies at eight. Legal, and the gate must measure it relative to the grid.

!!! info "Nested"

    <div class="grid cards" markdown>

    -   **[Four](four.md)**

        ---

        Body at eight columns, correct for a grid that starts at four.

    </div>

A card whose body wraps its own div. The inner close must not end the grid, or
every later card goes unchecked.

<div class="grid cards" markdown>

-   **[Five](five.md)**

    ---

    <div class="result" markdown>
    Wrapped body.
    </div>

-   **[Six](six.md)**

    ---

    Still inside the grid, so this card is still checked.

</div>

A wrapped card title with no blank line under the marker. Markdown folds a lazy
continuation into the item at any indent, so it renders inside the card.

<div class="grid cards" markdown>

-   **[A card whose title runs past the print width and wraps onto the
next source line](seven.md)**

    ---

    Body still at four.

</div>

A fenced block showing the broken form. It is literal text, so the gate must not
read it as markup — including the unclosed opener.

```markdown
<div class="grid cards" markdown>

- **Card**

  ***

  Two-space body inside a code sample.
```
