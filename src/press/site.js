import saveAs from "file-saver"
import slugify from "slugify"
import {
  copyFolder,
  ensureFolders,
  copyImages,
  addToZip,
} from "../common/fs.js"
import { fix } from "../common/fixes.js"
import "../common/templateHelpers.js"
import {
  extractToc,
  registerToCLabel,
  registerToCMatchRules,
  registerToCPrefix,
  safeId,
} from "../common/utils.js"

import Handlebars from "handlebars"
import JSZip from "jszip"
import { generateEpub } from "./epub.js"
import { staticSiteGenerating } from "./stores.js"
// markdown & plugins
import MarkdownIt from "markdown-it"
import MarkdownFootnote from "markdown-it-footnote"
import MarkdownAnchor from "markdown-it-anchor"
import MarkdownAttrs from "markdown-it-attrs"
import MarkdownBracketedSpans from "markdown-it-bracketed-spans"
import MarkdownImplicitFigues from "markdown-it-implicit-figures"
import MarkdownCenterText from "markdown-it-center-text"
import MarkdownEmoji from "markdown-it-emoji"

// DEFAULT OPTIONS
let md = new MarkdownIt({
  xhtmlOut: true,
  linkify: true,
  typographer: true,
})
  .use(MarkdownFootnote)
  .use(MarkdownAnchor, { slugify })
  .use(MarkdownBracketedSpans)
  .use(MarkdownAttrs)
  .use(MarkdownImplicitFigues, { figcaption: true })
  .use(MarkdownEmoji)
  .use(MarkdownCenterText)

// IMPLEMENTATION

let currentTheme = "generic"

function setTheme(theme) {
  currentTheme = theme
}

function themeFolder() {
  return `/templates/${currentTheme}/site`
}

function themePathFor(file) {
  return `${themeFolder()}/${file}`
}

function contentFilesFromConfiguration(book) {
  let frontmatter =
    book.config.site.frontmatter.length > 0
      ? book.config.site.frontmatter
      : book.config.book.frontmatter
  let chapters =
    book.config.site.chapters.length > 0
      ? book.config.site.chapters
      : book.config.book.chapters
  let backmatter =
    book.config.site.backmatter.length > 0
      ? book.config.site.backmatter
      : book.config.book.backmatter

  let contentFiles = [...frontmatter, ...chapters, ...backmatter]

  return contentFiles
}

function isFrontmatter(book, file) {
  let frontmatter =
    book.config.site.frontmatter.length > 0
      ? book.config.site.frontmatter
      : book.config.book.frontmatter
  return frontmatter.includes(file)
}

function isBackmatter(book, file) {
  let backmatter =
    book.config.site.backmatter.length > 0
      ? book.config.site.backmatter
      : book.config.book.backmatter
  return backmatter.includes(file)
}

export function generateSite(book) {
  // Sit back, relax, and enjoy the waterfall...
  console.log("Generate site", book)
  return new Promise((resolve, reject) => {
    let bookSlug = slugify(book.config.metadata.title)
    let fs = require("fs")
    let siteFolder = `/tmp/${bookSlug}-site`
    let bookFile = `/books/${bookSlug}.epub`
    let toc = {}

    staticSiteGenerating.set(true)

    setTheme(book.config.site.theme)

    if (!fs.existsSync(themeFolder())) {
      reject({ message: "theme-not-found" })
    }

    if (!fs.existsSync(bookFile)) {
      generateEpub(book).then(() => {
        generateSite(book)
          .then(() => resolve())
          .catch((n) => reject(n))
      })
      return false
    }

    if (!fs.existsSync(siteFolder)) {
      fs.mkdirSync(siteFolder)
    }

    // Copy files over...
    ensureFolders(`${siteFolder}/files/${bookSlug}.epub`)
    copyFolder(themeFolder(), siteFolder)
    fs.writeFileSync(
      `${siteFolder}/files/${bookSlug}.epub`,
      fs.readFileSync(bookFile)
    )

    let fi = copyImages(book, `${siteFolder}`)

    let contentFiles = contentFilesFromConfiguration(book)

    let fp = contentFiles.map(async (chapterFilename) => {
      let file = book.files.filter((f) => f.name === chapterFilename)[0]
      let contentMarkdown = await file.text()
      let contentHtml = md.render(contentMarkdown)
      contentHtml = fix(contentHtml)
      let destinationFilename = chapterFilename.replace(".md", ".xhtml")
      let destination = `${siteFolder}/book/${destinationFilename}`
      //let data = chapterTemplate({ html: contentHtml })
      //fs.writeFileSync(destination, data)

      // due to the async nature of this code, the ToC won't ready until
      // all promises complete.
      if (!isFrontmatter(book, chapterFilename)) {
        toc[destinationFilename] = extractToc(contentHtml, destinationFilename)
      }
    })

    let spine = contentFiles.map((f) => {
      let i = f.split(".")[0]
      return { id: `c-${i}`, file: i, htmlFile: `${i}.html` }
    })

    // site zip file...
    Promise.all([...fi, ...fp]).then(() => {
      spine = spine.map((s) => {
        s.toc = toc[s.htmlFile]
        return s
      })

      // Templating
      if (book.config.site.description) {
        book.config.site.description = md.render(book.config.site.description)
      }

      if (book.config.site.blurb) {
        book.config.site.blurb = md.render(book.config.site.blurb)
      }

      let indexTemplateHBS = fs.readFileSync(themePathFor("index.hbs"), "utf8")

      let indexTemplate = Handlebars.compile(indexTemplateHBS)
      let contents = indexTemplate({ book, spine })
      fs.writeFileSync(`${siteFolder}/index.html`, contents)

      let zip = new JSZip()
      addToZip(zip, `${bookSlug}-site`, siteFolder)
      zip.generateAsync({ type: "blob" }).then(
        function (blob) {
          saveAs(blob, `${bookSlug}-site.zip`)
          staticSiteGenerating.set(false)
          resolve()
        },
        function (err) {
          staticSiteGenerating.set(false)
          reject(err)
        }
      )
    })
  })
}
