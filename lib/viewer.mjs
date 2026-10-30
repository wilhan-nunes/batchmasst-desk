// Serialized into each exported report: no server or external scripts are needed to open it.
function viewer(root, title, context) {
  "use strict";
  var $ = function (id) {
    return document.getElementById(id);
  };
  var collapsed = new Set(),
    currentSvg;
  $("title").textContent = title;
  $("parameters").textContent = JSON.stringify(
    context.parameters || {},
    null,
    2,
  );
  function el(tag, text) {
    var e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function qualifies(n) {
    return (
      !$("only").checked || n.matched_size >= Number($("minimum").value || 1)
    );
  }
  function label(n) {
    return (
      (n.name || n.ID || n.NCBI || "Node") +
      " — " +
      n.matched_size +
      " / " +
      n.group_size +
      " (" +
      (100 * n.occurrence_fraction).toFixed(2) +
      "%)"
    );
  }
  function details(n) {
    var element = el("details"),
      summary = el("summary", label(n)),
      built = false;
    element.appendChild(summary);
    element.addEventListener("toggle", function () {
      if (!element.open || built) return;
      built = true;
      var meta = el(
        "small",
        [
          n.Rank,
          n.NCBI && "NCBI: " + n.NCBI,
          n.ID && "ID: " + n.ID,
          n.Interventions,
          n.Community_composition,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      element.appendChild(meta);
      var children = (n.children || []).filter(qualifies);
      children.slice(0, 200).forEach(function (c) {
        element.appendChild(details(c));
      });
      if (children.length > 200)
        element.appendChild(
          el(
            "p",
            "Showing first 200 child nodes. Search by name or download JSON for all nodes.",
          ),
        );
      (n.matches || []).slice(0, 200).forEach(function (m) {
        var p = el("p"),
          a = el("a", m.USI);
        a.href =
          "https://metabolomics-usi.gnps2.org/dashinterface/?usi1=" +
          encodeURIComponent(m.USI);
        a.target = "_blank";
        a.rel = "noopener";
        p.appendChild(a);
        p.appendChild(
          document.createTextNode(
            " · cosine " +
              Number(m.Cosine).toFixed(3) +
              " · peaks " +
              m["Matching Peaks"] +
              " · Δ " +
              Number(m["Delta Mass"]).toFixed(4),
          ),
        );
        element.appendChild(p);
      });
      if ((n.matches || []).length > 200)
        element.appendChild(
          el(
            "p",
            "Showing first 200 direct matches. Download JSON for all matches.",
          ),
        );
    });
    return element;
  }
  function svgEl(tag, attrs, text) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach(function (k) {
      e.setAttribute(k, attrs[k]);
    });
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function graph() {
    var nodes = [],
      depth = Number($("depth").value),
      zoom = Number($("zoom").value) / 100;
    function visit(n, level, parent) {
      if (nodes.length >= 200 || (level && !qualifies(n))) return;
      var point = {
        n: n,
        x: 25 + level * 320,
        y: 30 + nodes.length * 34,
        parent: parent,
      };
      nodes.push(point);
      if (level < depth && !collapsed.has(n))
        (n.children || []).forEach(function (c) {
          visit(c, level + 1, point);
        });
    }
    visit(root, 0, null);
    var width = Math.max(
        850,
        nodes.reduce(function (m, p) {
          return Math.max(m, p.x + 450);
        }, 0),
      ),
      height = Math.max(100, nodes.length * 34 + 40);
    var svg = svgEl("svg", {
      xmlns: "http://www.w3.org/2000/svg",
      width: width * zoom,
      height: height * zoom,
      viewBox: "0 0 " + width + " " + height,
      role: "img",
      "aria-label": "batchMASST Desk tree diagram",
    });
    nodes.forEach(function (p) {
      if (p.parent)
        svg.appendChild(
          svgEl("path", {
            d:
              "M" +
              p.parent.x +
              "," +
              p.parent.y +
              " H" +
              (p.x - 20) +
              " V" +
              p.y +
              " H" +
              p.x,
            stroke: "#c6d0db",
            fill: "none",
          }),
        );
    });
    nodes.forEach(function (p) {
      var g = svgEl("g", {
        tabindex: "0",
        role: "button",
        "aria-label": label(p.n),
        style: "cursor:pointer",
      });
      g.appendChild(
        svgEl("circle", {
          cx: p.x,
          cy: p.y,
          r: 8,
          fill: "#eef3fc",
          stroke: "#2980b9",
        }),
      );
      g.appendChild(
        svgEl("circle", {
          cx: p.x,
          cy: p.y,
          r: 5,
          fill: "none",
          stroke: "#2980b9",
          "stroke-width": 6,
          "stroke-dasharray":
            Math.min(1, Math.max(0, p.n.occurrence_fraction)) * 31.416 +
            " 31.416",
          transform: "rotate(-90 " + p.x + " " + p.y + ")",
        }),
      );
      g.appendChild(
        svgEl(
          "text",
          {
            x: p.x + 15,
            y: p.y + 4,
            fill: "#222",
            "font-family": "system-ui,sans-serif",
            "font-size": 12,
          },
          (p.n.name || p.n.ID || "Node") +
            " [" +
            p.n.matched_size +
            "/" +
            p.n.group_size +
            "]" +
            (collapsed.has(p.n) ? " +" : ""),
        ),
      );
      g.appendChild(svgEl("title", {}, label(p.n)));
      function toggle() {
        if (collapsed.has(p.n)) collapsed.delete(p.n);
        else collapsed.add(p.n);
        graph();
      }
      g.addEventListener("click", toggle);
      g.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
      svg.appendChild(g);
    });
    $("graph").replaceChildren(svg);
    currentSvg = svg;
    $("graph-note").textContent =
      nodes.length +
      " visible nodes (maximum 200). Click nodes to collapse / expand; scroll to pan. Use depth and zoom to explore.";
  }
  function render() {
    $("tree").replaceChildren();
    var q = $("search").value.toLowerCase(),
      count = 0;
    if (!q) {
      var e = details(root);
      $("tree").appendChild(e);
      e.open = true;
    } else {
      function walk(n) {
        if (count >= 200) return;
        if (
          (String(n.name) + " " + n.ID + " " + n.NCBI)
            .toLowerCase()
            .includes(q) &&
          qualifies(n)
        ) {
          $("tree").appendChild(details(n));
          count++;
        }
        (n.children || []).forEach(walk);
      }
      walk(root);
      $("tree").prepend(
        el(
          "p",
          count ? "Showing up to 200 matching nodes." : "No matching nodes.",
        ),
      );
    }
    graph();
  }
  function save(data, type, name) {
    var url = URL.createObjectURL(new Blob([data], { type: type })),
      a = el("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }
  $("search").oninput = render;
  $("only").onchange = render;
  $("minimum").onchange = render;
  $("depth").oninput = graph;
  $("zoom").oninput = graph;
  $("reset").onclick = function () {
    $("search").value = "";
    collapsed.clear();
    render();
  };
  $("download").onclick = function () {
    save(JSON.stringify(root), "application/json", "tree.json");
  };
  $("svg-download").onclick = function () {
    save(
      new XMLSerializer().serializeToString(currentSvg),
      "image/svg+xml",
      "tree.svg",
    );
  };
  $("nodes-download").onclick = function () {
    var rows = [["Name", "Rank", "ID", "Samples", "Matches", "Fraction"]];
    function visit(n) {
      if (qualifies(n))
        rows.push([
          n.name,
          n.Rank,
          n.NCBI || n.ID || n.name,
          n.group_size,
          n.matched_size,
          n.occurrence_fraction,
        ]);
      (n.children || []).forEach(visit);
    }
    visit(root);
    save(
      rows
        .map(function (r) {
          return r
            .map(function (v) {
              return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
            })
            .join(",");
        })
        .join("\n"),
      "text/csv",
      "nodes.csv",
    );
  };
  var annotations = context.library || [];
  if (annotations.length) {
    var table = el("table"),
      header = el("tr");
    ["Compound", "Accession", "Cosine", "Matched peaks"].forEach(function (s) {
      header.appendChild(el("th", s));
    });
    table.appendChild(header);
    annotations.forEach(function (r) {
      var tr = el("tr");
      [
        r.CompoundName,
        r.GNPSLibraryAccession,
        Number(r.Cosine).toFixed(3),
        r["Matching Peaks"],
      ].forEach(function (v) {
        tr.appendChild(el("td", v));
      });
      table.appendChild(tr);
    });
    $("annotations").appendChild(table);
  } else
    $("annotations").appendChild(
      el("p", "No library annotations available in this report."),
    );
  render();
}
export function treeHtml(tree, title, context = {}) {
  const encode = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>batchMASST Desk tree</title><style>
body{font:15px system-ui;margin:24px;color:#222;background:#fafafa}h1{font-size:26px}input,button{font:inherit;padding:7px;margin:4px}button{background:#2980b9;color:white;border:0;border-radius:4px;cursor:pointer}details{margin:10px 0 10px 20px}summary{cursor:pointer}small{color:#6c6c70}table{border-collapse:collapse}td,th{padding:7px;text-align:left;border-bottom:1px solid #e3e6ea}a{color:#2980b9}#tree,#graph{overflow:auto;background:white;border:1px solid #e3e6ea;padding:12px;max-height:700px}#graph{padding:0}#minimum{width:65px}pre{white-space:pre-wrap}p{line-height:1.5}.controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
</style></head><body><h1 id="title"></h1><p>Matched counts / reference samples. Counts may overlap across ontology branches, domains, and analog mass bins. Circle fill shows occurrence fraction, capped at 100% in the diagram.</p>
<div class="controls"><label><input id="only" type="checkbox" checked>Matched nodes only</label><label>Minimum matches <input id="minimum" type="number" min="1" value="1"></label><button id="reset">Reset</button><button id="download">Download tree JSON</button><button id="nodes-download">Download node table</button></div>
<h2>Tree diagram</h2><div class="controls"><label>Depth <input id="depth" type="range" min="1" max="30" value="6"></label><label>Zoom <input id="zoom" type="range" min="30" max="200" value="100"></label><button id="svg-download">Download SVG</button></div><p id="graph-note"></p><div id="graph"></div>
<h2>Explore nodes and spectra</h2><label>Find node <input id="search" placeholder="Name or ID"></label><div id="tree"></div><details><summary>Library annotations (first 200; full table in library.tsv)</summary><div id="annotations"></div></details><details><summary>Search parameters</summary><pre id="parameters"></pre></details>
<script>(${viewer.toString()})(${encode(tree)},${encode(title)},${encode(context)});</script></body></html>`;
}
