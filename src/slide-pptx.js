// SDOC Slides — PowerPoint / Google Slides export.
//
// Turns harvested slide geometry (src/slide-geometry.js) into a .pptx. Drive
// imports a .pptx as a native Google Slides deck, which is why this is the
// export route rather than the Slides REST API: no OAuth in the toolchain, no
// per-shape API calls, and the output is a useful artefact on its own.
//
// Fidelity comes from the harvest, not from this file. The browser has already
// decided where every box, line and run of text sits; here each of those
// becomes one absolutely positioned shape. That is also how a designed deck is
// built by hand — every slide is loose shapes on one blank layout — so the
// exported file matches the kind of file a designer would hand over, and stays
// editable in Slides.
//
// Zero dependencies: the OOXML is written out directly and src/zip.js packages
// it with Node's zlib.

const fs = require("fs");
const path = require("path");
const { zip, crc32 } = require("./zip");

const EMU_PER_PX = 9525; // 914400 EMU per inch / 96 px per inch
const PT_PER_PX = 0.75; // 72 pt per inch / 96 px per inch

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters are not legal in XML 1.0 and will not open.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

const px = (v) => Math.round(v * EMU_PER_PX);
const pt100 = (v) => Math.round(v * PT_PER_PX * 100);

// Generic font-family keywords never name a real face; fall back to something
// PowerPoint and Slides both resolve.
const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-monospace", "ui-sans-serif", "ui-serif", "ui-rounded",
  "-apple-system", "BlinkMacSystemFont",
]);

function fontName(name, fallback) {
  if (!name || GENERIC_FAMILIES.has(name)) return fallback;
  return name;
}

function solidFill(hex, alpha) {
  const colour = `<a:srgbClr val="${(hex || "FFFFFF").replace("#", "").toUpperCase()}"${
    alpha !== undefined && alpha < 1 ? `><a:alpha val="${Math.round(alpha * 100000)}"/></a:srgbClr>` : "/>"
  }`;
  return `<a:solidFill>${colour}</a:solidFill>`;
}

function xfrm(box) {
  return (
    `<a:xfrm><a:off x="${px(box.x)}" y="${px(box.y)}"/>` +
    `<a:ext cx="${px(Math.max(box.w, 1))}" cy="${px(Math.max(box.h, 1))}"/></a:xfrm>`
  );
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function rectShape(id, name, box, opts = {}) {
  const geom = opts.radius
    ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.min(
        50000,
        Math.round((opts.radius / Math.max(1, Math.min(box.w, box.h))) * 100000)
      )}"/></a:avLst></a:prstGeom>`
    : `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;

  const fill = opts.fill ? solidFill(opts.fill, opts.fillAlpha) : "<a:noFill/>";
  const line = opts.line
    ? `<a:ln w="${Math.max(1, Math.round(opts.line.width * PT_PER_PX * 12700))}">${solidFill(
        opts.line.colour,
        opts.line.alpha
      )}</a:ln>`
    : "<a:ln><a:noFill/></a:ln>";

  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}${geom}${fill}${line}</p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`
  );
}

const ALIGN = { left: "l", start: "l", center: "ctr", right: "r", end: "r", justify: "just" };

function textShape(id, name, atom, fallbacks) {
  const runs = atom.runs
    .map((run) => {
      const props =
        `<a:rPr lang="en-US" sz="${Math.round(run.size * PT_PER_PX * 100)}"` +
        (run.weight >= 600 ? ' b="1"' : "") +
        (run.italic ? ' i="1"' : "") +
        (run.spacing ? ` spc="${Math.round(run.spacing * PT_PER_PX * 100)}"` : "") +
        ` dirty="0">` +
        solidFill(run.color) +
        `<a:latin typeface="${esc(fontName(run.font, fallbacks.body))}"/>` +
        `<a:cs typeface="${esc(fontName(run.font, fallbacks.body))}"/>` +
        `</a:rPr>`;
      return `<a:r>${props}<a:t>${esc(run.text)}</a:t></a:r>`;
    })
    .join("");

  // Exact line spacing, so a line box in the export is the line box the
  // browser laid out. Autofit is off: the harvest already sized the box.
  const spacing = atom.lineHeight ? `<a:lnSpc><a:spcPts val="${pt100(atom.lineHeight)}"/></a:lnSpc>` : "";
  const align = ALIGN[atom.align] ? ` algn="${ALIGN[atom.align]}"` : "";

  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/>` +
    `<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(atom.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody>` +
    `<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr>` +
    `<a:lstStyle/>` +
    `<a:p><a:pPr${align}>${spacing}</a:pPr>${runs}</a:p>` +
    `</p:txBody></p:sp>`
  );
}

function pictureShape(id, name, box, relId) {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(name)}"/>` +
    `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

// Resolves an <img src> to bytes: a data: URI, or a file beside the deck.
function readImage(src, baseDir) {
  if (!src) return null;
  const dataMatch = src.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (dataMatch) {
    const mime = dataMatch[1];
    const data = dataMatch[2]
      ? Buffer.from(dataMatch[3], "base64")
      : Buffer.from(decodeURIComponent(dataMatch[3]), "utf-8");
    const ext = Object.keys(IMAGE_TYPES).find((e) => IMAGE_TYPES[e] === mime) || ".png";
    return { data, ext, mime };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null; // remote: nothing to embed
  const filePath = path.resolve(baseDir, decodeURIComponent(src.replace(/[?#].*$/, "")));
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_TYPES[ext]) return null;
  return { data: fs.readFileSync(filePath), ext, mime: IMAGE_TYPES[ext] };
}

// ---------------------------------------------------------------------------
// Package boilerplate
// ---------------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// The OOXML colour scheme. Every visible colour in an exported deck is written
// literally on its own shape, harvested from the CSS, so this scheme is only
// what PowerPoint offers in its colour picker once the file is open. It is
// deliberately neutral: a theme's palette belongs in the theme's CSS, not
// baked into the exporter.
const SCHEME_COLOURS = {
  dk2: "44546A",
  lt2: "E7E6E6",
  accent1: "4472C4",
  accent2: "ED7D31",
  accent3: "A5A5A5",
  accent4: "FFC000",
  accent5: "5B9BD5",
  accent6: "70AD47",
  hlink: "0563C1",
  folHlink: "954F72",
};

function themeXml(fonts) {
  const scheme = (name, hex) => `<a:${name}><a:srgbClr val="${hex}"/></a:${name}>`;
  const fill =
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const fillStyles = `<a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst>`;
  const lineStyle =
    '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>';
  return (
    XML_DECL +
    `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="SDOC">` +
    `<a:themeElements><a:clrScheme name="SDOC">` +
    `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
    `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    Object.entries(SCHEME_COLOURS)
      .map(([name, hex]) => scheme(name, hex))
      .join("") +
    `</a:clrScheme>` +
    `<a:fontScheme name="SDOC">` +
    `<a:majorFont><a:latin typeface="${esc(fonts.display)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="${esc(fonts.body)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    `</a:fontScheme>` +
    `<a:fmtScheme name="SDOC">${fillStyles}` +
    `<a:lnStyleLst>${lineStyle}${lineStyle}${lineStyle}</a:lnStyleLst>` +
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst>` +
    `</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
  );
}

function emptyTree() {
  return (
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`
  );
}

const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

function slideMasterXml(background) {
  return (
    XML_DECL +
    `<p:sldMaster ${NS}><p:cSld>` +
    `<p:bg><p:bgPr>${solidFill(background)}<a:effectLst/></p:bgPr></p:bg>` +
    emptyTree() +
    `</p:cSld>${CLR_MAP}` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
    `</p:sldMaster>`
  );
}

function slideLayoutXml(background) {
  return (
    XML_DECL +
    `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="DEFAULT">` +
    `<p:bg><p:bgPr>${solidFill(background)}<a:effectLst/></p:bgPr></p:bg>` +
    emptyTree() +
    `</p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" ` +
    `accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" ` +
    `accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sldLayout>`
  );
}

function notesMasterXml() {
  return (
    XML_DECL +
    `<p:notesMaster ${NS}><p:cSld>${emptyTree()}</p:cSld>${CLR_MAP}` +
    `<p:notesStyle><a:lvl1pPr><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle></p:notesMaster>`
  );
}

function notesSlideXml(text) {
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => `<a:p><a:r><a:rPr lang="en-US" sz="1200" dirty="0"/><a:t>${esc(p.trim())}</a:t></a:r></a:p>`)
    .join("");
  return (
    XML_DECL +
    `<p:notes ${NS}><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/>` +
    `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>` +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
  );
}

function relsXml(rels) {
  return (
    XML_DECL +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels
      .map(
        (rel) =>
          `<Relationship Id="${rel.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${rel.type}" Target="${rel.target}"/>`
      )
      .join("") +
    `</Relationships>`
  );
}

// ---------------------------------------------------------------------------
// Slide assembly
// ---------------------------------------------------------------------------

// A box with a border on only some sides exports as a filled bar per side
// rather than as an outlined rectangle: a one-pixel underline under a heading
// should be a hairline in Slides, not a box with three invisible edges.
function edgeBars(atom) {
  const bars = [];
  const { box, border } = atom;
  const w = border.width;
  for (const side of border.sides) {
    if (side === "top") bars.push({ x: box.x, y: box.y, w: box.w, h: w });
    else if (side === "bottom") bars.push({ x: box.x, y: box.y + box.h - w, w: box.w, h: w });
    else if (side === "left") bars.push({ x: box.x, y: box.y, w: w, h: box.h });
    else if (side === "right") bars.push({ x: box.x + box.w - w, y: box.y, w: w, h: box.h });
  }
  return bars;
}

function buildSlideXml(slide, context) {
  const shapes = [];
  let id = context.nextId;

  for (const atom of slide.atoms) {
    if (atom.kind === "box") {
      // Fill first, then any partial edges, so a wash sits under its rules.
      if (atom.fill) {
        const n = id++;
        shapes.push(
          rectShape(n, `box-${n}`, atom.box, {
            fill: atom.fill,
            fillAlpha: atom.fillAlpha,
            radius: atom.radius,
          })
        );
      }
      if (atom.border) {
        if (atom.border.sides === "all") {
          const n = id++;
          shapes.push(
            rectShape(n, `outline-${n}`, atom.box, {
              radius: atom.radius,
              line: atom.border,
            })
          );
        } else {
          for (const bar of edgeBars(atom)) {
            const n = id++;
            shapes.push(
              rectShape(n, `rule-${n}`, bar, {
                fill: atom.border.colour,
                fillAlpha: atom.border.alpha,
              })
            );
          }
        }
      }
    } else if (atom.kind === "text") {
      const n = id++;
      shapes.push(textShape(n, `text-${n}`, atom, context.fonts));
    } else if (atom.kind === "image") {
      const image = readImage(atom.src, context.baseDir);
      if (image) {
        const relId = context.addImage(image);
        const n = id++;
        shapes.push(pictureShape(n, atom.alt || `image-${n}`, atom.box, relId));
      } else {
        context.skippedImages.push(atom.src || "(no src)");
      }
    }
  }

  context.nextId = id;
  const background = slide.background ? slide.background.hex : context.background;

  return (
    XML_DECL +
    `<p:sld ${NS}><p:cSld>` +
    `<p:bg><p:bgPr>${solidFill(background)}<a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shapes.join("") +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// geometry — the output of harvestGeometry()
// options.baseDir  — directory relative <img src> values resolve against
// options.fonts    — { display, body } fallback typefaces
// options.title    — deck title, for docProps
function buildPptx(geometry, options = {}) {
  const width = geometry.box.w;
  const height = geometry.box.h;
  // A face named here is only reached when a CSS stack resolved to a generic
  // family, so it has to be one every viewer already has. A theme names its
  // own with `fonts` in theme.json.
  const fonts = { display: "Helvetica", body: "Helvetica", ...(options.fonts || {}) };
  const baseDir = options.baseDir || process.cwd();
  const title = options.title || "Slides";

  const images = [];
  const imageByKey = new Map();
  const skippedImages = [];

  const files = [];
  const slideEntries = [];

  const slides = geometry.slides;
  const background =
    (slides[0] && slides[0].background && slides[0].background.hex) || "FFFFFF";

  slides.forEach((slide, index) => {
    const n = index + 1;
    const slideImages = [];

    const context = {
      nextId: 2,
      fonts,
      baseDir,
      background,
      skippedImages,
      addImage(image) {
        const key = crc32(image.data) + ":" + image.data.length;
        let entry = imageByKey.get(key);
        if (!entry) {
          entry = { index: images.length + 1, ...image };
          images.push(entry);
          imageByKey.set(key, entry);
        }
        const relId = `rId${slideImages.length + 2}`; // rId1 is the layout
        slideImages.push({ relId, entry });
        return relId;
      },
    };

    files.push({ name: `ppt/slides/slide${n}.xml`, data: buildSlideXml(slide, context) });

    const rels = [{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }];
    for (const { relId, entry } of slideImages) {
      rels.push({ id: relId, type: "image", target: `../media/image${entry.index}${entry.ext}` });
    }
    const hasNotes = slide.notes && slide.notes.trim().length > 0;
    if (hasNotes) {
      rels.push({
        id: `rId${slideImages.length + 2}`,
        type: "notesSlide",
        target: `../notesSlides/notesSlide${n}.xml`,
      });
      files.push({ name: `ppt/notesSlides/notesSlide${n}.xml`, data: notesSlideXml(slide.notes) });
      files.push({
        name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        data: relsXml([
          { id: "rId1", type: "notesMaster", target: "../notesMasters/notesMaster1.xml" },
          { id: "rId2", type: "slide", target: `../slides/slide${n}.xml` },
        ]),
      });
    }
    files.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: relsXml(rels) });
    slideEntries.push({ n, hasNotes });
  });

  for (const image of images) {
    files.push({ name: `ppt/media/image${image.index}${image.ext}`, data: image.data, store: true });
  }

  // presentation.xml and its relationships
  const presRels = [{ id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" }];
  const sldIds = slideEntries
    .map((entry, i) => {
      const rid = `rId${i + 2}`;
      presRels.push({ id: rid, type: "slide", target: `slides/slide${entry.n}.xml` });
      return `<p:sldId id="${256 + i}" r:id="${rid}"/>`;
    })
    .join("");
  const notesMasterRid = `rId${slideEntries.length + 2}`;
  presRels.push({ id: notesMasterRid, type: "notesMaster", target: "notesMasters/notesMaster1.xml" });
  presRels.push({ id: `rId${slideEntries.length + 3}`, type: "theme", target: "theme/theme1.xml" });

  files.push({
    name: "ppt/presentation.xml",
    data:
      XML_DECL +
      `<p:presentation ${NS} saveSubsetFonts="1">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRid}"/></p:notesMasterIdLst>` +
      `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
      `<p:sldSz cx="${px(width)}" cy="${px(height)}"/>` +
      `<p:notesSz cx="6858000" cy="9144000"/>` +
      `</p:presentation>`,
  });
  files.push({ name: "ppt/_rels/presentation.xml.rels", data: relsXml(presRels) });

  files.push({ name: "ppt/slideMasters/slideMaster1.xml", data: slideMasterXml(background) });
  files.push({
    name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    data: relsXml([
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: "theme", target: "../theme/theme1.xml" },
    ]),
  });
  files.push({ name: "ppt/slideLayouts/slideLayout1.xml", data: slideLayoutXml(background) });
  files.push({
    name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    data: relsXml([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
  });
  files.push({ name: "ppt/notesMasters/notesMaster1.xml", data: notesMasterXml() });
  files.push({
    name: "ppt/notesMasters/_rels/notesMaster1.xml.rels",
    data: relsXml([{ id: "rId1", type: "theme", target: "../theme/theme1.xml" }]),
  });
  files.push({ name: "ppt/theme/theme1.xml", data: themeXml(fonts) });

  // Package plumbing
  const imageTypes = [...new Set(images.map((i) => i.ext.replace(".", "")))];
  files.push({
    name: "[Content_Types].xml",
    data:
      XML_DECL +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      imageTypes
        .map((ext) => {
          const mime = IMAGE_TYPES["." + ext] || "image/png";
          return `<Default Extension="${ext}" ContentType="${mime}"/>`;
        })
        .join("") +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      slideEntries
        .map(
          (entry) =>
            `<Override PartName="/ppt/slides/slide${entry.n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
            (entry.hasNotes
              ? `<Override PartName="/ppt/notesSlides/notesSlide${entry.n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`
              : "")
        )
        .join("") +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `</Types>`,
  });

  files.push({
    name: "_rels/.rels",
    data: relsXml([
      { id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" },
      { id: "rId2", type: "metadata/core-properties", target: "docProps/core.xml" },
      { id: "rId3", type: "extended-properties", target: "docProps/app.xml" },
    ]),
  });

  files.push({
    name: "docProps/core.xml",
    data:
      XML_DECL +
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${esc(title)}</dc:title><cp:revision>1</cp:revision></cp:coreProperties>`,
  });

  files.push({
    name: "docProps/app.xml",
    data:
      XML_DECL +
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
      `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      `<Application>SDOC Slides</Application><Slides>${slideEntries.length}</Slides></Properties>`,
  });

  return { buffer: zip(files), skippedImages };
}

// Measures a built HTML deck and writes the .pptx beside it.
async function exportSlidePptx(htmlPath, pptxPath, options = {}) {
  const { harvestGeometry } = require("./slide-geometry");
  const geometry = await harvestGeometry(htmlPath, options);
  const { buffer, skippedImages } = buildPptx(geometry, {
    baseDir: path.dirname(path.resolve(htmlPath)),
    ...options,
  });
  fs.mkdirSync(path.dirname(path.resolve(pptxPath)), { recursive: true });
  fs.writeFileSync(path.resolve(pptxPath), buffer);
  return { path: path.resolve(pptxPath), slides: geometry.slides.length, skippedImages, geometry };
}

module.exports = { buildPptx, exportSlidePptx };
