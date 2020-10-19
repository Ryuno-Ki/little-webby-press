import BrowserFS from "browserfs"
import slug from "slug"
import marked from "marked"
import mime from "mime"
import saveAs from "file-saver"
import moment from "moment"
import { copyFolder } from "../common/fs.js"


// DEFAULT OPTIONS
// - marked
marked.setOptions({
    xhtml: true // EPUBs are XHTML.
})

// TEMPLATE HELPERS
Handlebars.registerHelper("dateModified", function (context, block) {
    return moment(Date(context)).format("YYYY-MM-DD[T]HH[:]mm[:00Z]");
});

Handlebars.registerHelper("tocIndex", function (context, block) {
    let n = new Number(context)

    if (!isNaN(n)) {
        return n + 3
    } else {
        return context
    }
});

Handlebars.registerHelper("chapterTitle", function (context, block) {
    return `Chapter ${context}`
});

Handlebars.registerHelper("mime", function (context, block) {
    return mime.getType(context)
});

// IMPLEMENTATION

function copyImages(book, destination) {
    let fs = require("fs")

    let files = book.files.filter(f => {
        if (f.filepath.match(/^images/)) {
            return true
        }

        return false
    });

    let fps = files.map(async f => {
        let file = f.filepath
        let data = await f.arrayBuffer()
        let Buffer = BrowserFS.BFSRequire('buffer').Buffer;
        let d2 = Buffer.from(data)
        let p = `${destination}/${file}`
        ensureFolders(p)
        fs.writeFileSync(p, d2)
    })
    return fps
}

function addToZip(zip, slug, folder) {
    let fs = require("fs")

    let items = fs.readdirSync(folder)
    console.log(folder, items)
    while (items.length > 0) {
        let a1 = `${folder}/${items.shift()}`
        let stat = fs.statSync(a1)
        if (stat.isDirectory()) {
            addToZip(zip, slug, a1)
        } else {
            let content = fs.readFileSync(a1)
            let destinationPath = a1.replace(`/tmp/${slug}/`, "")
            zip.file(destinationPath, content)
        }
    }
}

function ensureFolders(path) {
    let fs = require("fs")

    let a = path.split("/")
    a.splice(0, 1)
    let a1 = `/${a.shift()}`
    while (a.length >= 1) {
        if (!fs.existsSync(a1)) {
            fs.mkdirSync(a1)
        }
        a1 = `${a1}/${a.shift()}`
    }
}


function fixImages(html) {
    html = html.replace(/src="\//gi, `src="`)
    return html
}

function fixLinks(html) {
    html = html.replace(/href="\//gi, `href="`)
    return html
}

function fix(html) {
    html = fixImages(html)
    html = fixLinks(html)
    return html
}

export function generateEbook(book) {
    return new Promise((resolve, reject) => {
        let bookSlug = slug(book.config.metadata.title)
        let fs = require("fs")
        let folder = `/tmp/${bookSlug}`

        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder)
        }
        ensureFolders("${folder}/OPS/package.opf")
        copyFolder("/templates/epub", folder)
        let fi = copyImages(book, `${folder}/OPS`)

        let chapterTemplateHBS = fs.readFileSync("/templates/epub/chapter.hbs", "utf8")
        let chapterTemplate = Handlebars.compile(chapterTemplateHBS)
        let fp = book.config.profiles.book.map(async chapterFilename => {
            let file = book.files.filter(f => f.name === chapterFilename)[0]

            let contentMarkdown = await file.text()
            let contentHtml = marked(contentMarkdown)
            contentHtml = fix(contentHtml)
            let destinationFilename = chapterFilename.replace(".md", ".xhtml")
            let destination = `${folder}/OPS/${destinationFilename}`
            let data = chapterTemplate({ html: contentHtml })
            fs.writeFileSync(destination, data)
        })

        // Find which files to add to manifest
        let files = book.files.filter(f => {
            if (book.config.profiles.book.includes(f.name)) {
                return true
            }

            if (f.filepath.match(/^images/)) {
                return true
            }

            return false
        });

        // Adding fonts to manifest
        let fonts = fs.readdirSync(`${folder}/OPS/fonts/`)
        fonts.forEach(f => {
            files.push({
                filepath: `fonts/${f}`,
                name: f
            })
        })

        let manifest = []

        files.forEach(file => {
            if (file.filepath == book.config.metadata.cover) {
                return
            }
            let f = file.filepath
            f = f.replace(".md", ".xhtml")
            let i = file.name.split(".")[0]
            let linear = "yes"
            if (f.indexOf(".xhtml") == -1) {
                linear = "no"
                i = `r-${i}`
            }
            manifest.push({
                id: i,
                file: f,
                linear
            })
        })

        // package.opf
        let spine = book.config.profiles.book.map(f => f.split(".")[0])
        let packageHBS = fs.readFileSync("/templates/epub/package.hbs", "utf8")
        let packageTemplate = Handlebars.compile(packageHBS)
        let packageData = packageTemplate({ book, manifest, spine })
        fs.writeFileSync(`${folder}/OPS/package.opf`, packageData)

        // toc.ncx
        let tocncxHBS = fs.readFileSync("/templates/epub/toc.ncx.hbs", "utf8")
        let tocncxTemplate = Handlebars.compile(tocncxHBS)
        let tocncxData = tocncxTemplate({ book, manifest, spine })
        fs.writeFileSync(`${folder}/OPS/toc.ncx`, tocncxData)

        // toc.xhtml
        let tocHBS = fs.readFileSync("/templates/epub/toc.hbs", "utf8")
        let tocTemplate = Handlebars.compile(tocHBS)
        let tocData = tocTemplate({ book, manifest, spine })
        fs.writeFileSync(`${folder}/OPS/toc.xhtml`, tocData)

        // cover.xhtml
        let coverHBS = fs.readFileSync("/templates/epub/cover.hbs", "utf8")
        let coverTemplate = Handlebars.compile(coverHBS)
        let coverData = coverTemplate({ book })
        fs.writeFileSync(`${folder}/OPS/cover.xhtml`, coverData)

        // EPUB3 file
        Promise.all([...fi, ...fp]).then(() => {
            let zip = new JSZip()
            let mimetype = fs.readFileSync(`${folder}/mimetype`)
            zip.file("mimetype", mimetype)
            addToZip(zip, bookSlug, folder)
            zip.generateAsync({ type: "blob" }).then(function (blob) {
                saveAs(blob, `${bookSlug}.epub`);
                resolve()
            }, function (err) {
                reject(err)
            });
        })
    })
}
