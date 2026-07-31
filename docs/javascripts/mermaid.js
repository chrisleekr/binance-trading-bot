// Self-owned Mermaid renderer.
//
// Material's built-in mermaid integration and the mkdocs-mermaid2 plugin both
// initialise mermaid with a config we can't control (htmlLabels off), which
// collapses <br/> line breaks and drops classDef text colours. We instead emit
// diagram fences under `pre.mermaid-block` (a class Material ignores) and render
// them here with htmlLabels on, so labels wrap on <br/> and classDef colours apply.

// Pinned to 11.4.0. Loaded from unpkg at runtime because SRI is unavailable for
// ESM `import`, and mermaid's ESM build lazy-loads diagram chunks relative to
// this URL, so it cannot be vendored as a single self-contained file. This
// matches mkdocs-material's own default mermaid loader. Diagrams are
// repo-authored, so the securityLevel below is the load-bearing control.
import mermaid from 'https://unpkg.com/mermaid@11.4.0/dist/mermaid.esm.min.mjs';

mermaid.initialize({
  startOnLoad: false,
  // antiscript allows HTML labels (<br/> line breaks, classDef colours) while
  // stripping <script>; strict would escape <br/>. Diagrams are repo-authored.
  securityLevel: 'antiscript',
  flowchart: { htmlLabels: true, useMaxWidth: true },
});

let seq = 0;

async function renderAll() {
  const blocks = document.querySelectorAll('pre.mermaid-block:not([data-rendered])');
  for (const pre of blocks) {
    const code = pre.querySelector('code') || pre;
    const source = code.textContent.trim();
    if (!source) continue;
    pre.dataset.rendered = '1';
    try {
      const { svg, bindFunctions } = await mermaid.render('mmd-' + seq++, source);
      pre.innerHTML = svg;
      if (bindFunctions) bindFunctions(pre);
    } catch (err) {
      delete pre.dataset.rendered;
      console.error('mermaid render failed:', err);
    }
  }
}

// Material fires document$ on first load and after every instant-navigation swap.
if (window.document$) {
  window.document$.subscribe(() => renderAll());
} else {
  document.addEventListener('DOMContentLoaded', renderAll);
}
