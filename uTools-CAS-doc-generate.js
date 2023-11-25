// @ts-check
/* eslint-env node */

const fs = require("fs")
const cheerio = require("cheerio")
const path = require("path")
const URL = require("url")
const PDFParser = require("pdf2json")
const util = require("util")
const mammoth = require("mammoth")
const WORD = require("word")

const BASEURL = new URL.URL("http://kjs.mof.gov.cn/zt/kjzzss/")
const pubDir = "public"
const staticDir = path.join(pubDir, "static")
const cacheDir = "cache"
fs.existsSync(cacheDir) || fs.mkdirSync(cacheDir)

const sleep = async ms => new Promise(resolve => setTimeout(resolve, ms))

const logPath = "log.log"
fs.existsSync(logPath) && fs.rmSync(logPath)
const logFile = fs.createWriteStream(logPath, { flags: "a" })

console.error = console.log = function () {
  const log = util.format.apply(null, arguments) + "\n"
  logFile.write(log)
  process.stdout.write(log)
}

/**
 * @param {URL.URL} url
 * @param {object} options
 * @param {boolean} [useCache=true]
 * @returns Promise<Response> response
 */
function cachedFetch(url, options, useCache = true) {
  const urlPath = url.pathname.split("/")
  urlPath.push(urlPath.pop() || "index.htm")
  const cachePath = path.join(cacheDir, ...urlPath)

  if (useCache && fs.existsSync(cachePath)) {
    const cacheFile = fs.readFileSync(cachePath)
    let response
    if (cacheFile.includes("温馨提示：您访问的页面不存在或已删除")) {
      response = new Response("", { status: 404, statusText: "404" })
    } else {
      response = new Response(new Blob([cacheFile]))
    }
    console.log(`[✓] Use cached file ${cachePath}`)
    return Promise.resolve(response)
  }

  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  const response = fetch(url, options)
  response
    .then(res => res.clone())
    .then(res => res.blob()) // Store
    .then(blob => blob.arrayBuffer())
    .then(ab => Buffer.from(ab))
    .then(buf => fs.writeFileSync(cachePath, buf))
    .then(console.log(`[✓] Fetch ${url} and save to ${cachePath}`))
    .catch(e => console.error(e))
  return response
}

/**
 * get index
 * @param {String} section
 * @returns { {url:String,t:String,d:String,p:fs.PathLike}[] } indexes
 */
async function getIndex(section, secName) {
  console.log(`[-] Generating index of ${section}`)

  /** @type { {url:String,sec:String,secName:String,subSec:String,subSecName:String}[] }docListPageUrls */

  const docListPageUrls = []
  const secUrl = new URL.URL(section + "/", BASEURL)
  const indexPageRes = await cachedFetch(secUrl)
  if (!indexPageRes.ok) return
  const $ = cheerio.load(await indexPageRes.text())

  /** @type {cheerio.cheerioObj[]} */
  const subPageRefs = $("div.zzright>div.listBox>h2.li-tit>span.on>a")
  if (subPageRefs.length === 0) {
    docListPageUrls.push({
      sec: section,
      secName,
      subSec: null,
      subSecName: null,
      url: secUrl
    })
  } else {
    await subPageRefs.get().forEach(dom => {
      const href = dom.attribs.href.trim()
      const subSec = href.match(/(?<=\.\/)\w+?(?=\/)/)[0]
      docListPageUrls.push({
        sec: section,
        secName,
        subSec,
        subSecName: $(dom).text(),
        url: new URL.URL(subSec + "/", secUrl)
      })
    })
  }

  console.log(`  [✓] ${secName} has ${docListPageUrls.length} subsec.`)

  // console.log(JSON.stringify(docListPageUrls))

  const indexes = []
  async function generateIndex({ sec, secName, subSec = "", subSecName, url }) {
    const docDir = path.join(staticDir, sec, subSec || "")
    fs.existsSync(docDir) || fs.mkdirSync(docDir, { recursive: true })

    for (let i = 0; i < 99; i++) {
      await sleep(1000)
      const pageNum = i > 0 ? "_" + i : ""
      const curPageUrl = new URL.URL("index" + pageNum + ".htm", url)

      const curPageRes = await cachedFetch(curPageUrl)
      if (curPageRes.url === "http://www.mof.gov.cn/404.htm" || !curPageRes.ok)
        break

      const $$ = cheerio.load(await curPageRes.text())
      $$("div.zzright>div.listBox ul.liBox>li>a")
        .get()
        .forEach(dom => {
          const docTitle = dom.attribs.title.trim()
          const docUrl = new URL.URL(dom.attribs.href.trim(), url)
          const docSrcName = path.basename(docUrl.toString())
          const docPath = path.join(docDir, docSrcName)
          const docDesc = ["企业会计准则", secName, subSecName, docTitle].join(
            " > "
          )
          indexes.push({
            url: docUrl,
            t: docTitle, // 收入准则应用案例——合同负债（电商平台预售购物卡）
            d: docDesc, // 企业会计准则 > 应用案例 > 收入准则应用案例 > 收入准则应用案例——合同负债（电商平台预售购物卡）
            p: docPath
          })
        })
      console.log(
        `  [✓] Got index of ${secName} - ${subSecName || secName}@page ${i + 1}`
      )
    }
    console.log(`[✓] Got index of ${secName} - ${subSecName || secName}`)
  }

  // task queue

  const parseDocListQueue = docListPageUrls.map(async sec => generateIndex(sec))
  await Promise.all(parseDocListQueue)
  return indexes
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<String>}
 */
function parseDocx(buffer) {
  return mammoth
    .convertToHtml({ buffer })
    .then(result => result.value)
    .catch(err => console.error("  [x] " + err))
}

/**
 * @param {Buffer} buffer
 * @returns {String}
 */
function parseDoc(buffer) {
  const doc = WORD.read(buffer)
  return WORD.to_text(doc)
    .split("\n")
    .map(line => `<p>${line}</p>`)
    .join("")
}

/**
 * @param { Buffer } buffer
 * @returns { Promise < String > }
 * */
function parsePdf(buffer) {
  return new Promise(resolve => {
    const pdfParser = new PDFParser(this, 1)
    pdfParser.parseBuffer(buffer)
    pdfParser.on("pdfParser_dataError", errData =>
      console.error(errData.parserError)
    )
    pdfParser.on("pdfParser_dataReady", pdfData => {
      resolve(
        pdfParser
          .getRawTextContent()
          .replace(/-{16}Page \(\d+\) Break-{16}(\s+\d+)?/g, "")
          .replace(/^1/, "")
          .split("\n")
          .map(line => `<p>${line.trim()}</p>`)
          .join("\n")
      )
    })
  })
}

/**
 * download pdf and convert to html
 * @param {URL.URL } attachUrl
 * @param { String } attachName file.pdf
 * @returns { cheerio.cheerioObj }
 * */
function DLAttachment(atthUrl) {
  console.log(`  [-] Fetching attachment @ ${atthUrl}`)
  const attachName = path.basename(atthUrl.toString())

  const extension = path.extname(atthUrl.toString()).toLowerCase()
  console.log(extension)

  /** @type {{String:callable}} parser */
  const parsers = { ".pdf": parsePdf, ".doc": parseDoc, ".docx": parseDocx }

  if (!(extension in parsers)) return Promise.resolve(cheerio.load(""))

  return cachedFetch(atthUrl)
    .then(res => res.blob())
    .then(blob => blob.arrayBuffer())
    .then(arrBuf => Buffer.from(arrBuf))
    .then(async buf => await parsers[extension](buf))
    .then(docXml => cheerio.load(`<div id="attachment">${docXml}</div>`))
    .then(console.log(`  [✓] Converted ${attachName} to html`))
    .catch(e => console.log(e))
}

/**
 * @param {String} docUrl
 * @param {String} docName
 * @param {fs.PathLike} docPath
 * @param {string} [htmlType="document"||"QA"] document || QA
 * @returns {undefined} undefined
 */
async function saveHTML(docUrl, docName, docPath, htmlType = "document") {
  console.log(`  [-] Fetching ${docName} @ ${docUrl}`)

  await sleep(1000)

  const res = await cachedFetch(docUrl)
  if (!res.ok) return

  const $ = cheerio.load(await res.text())

  const QA = $("#appendix>a")
  const attach = $("#appendix1>a")

  $(
    "div.sharebox,div.gu-download,div.clear,div.conboxdown,style,script"
  ).remove()

  const content = $("div.mainboxerji>div.box_content")
  content.attr("id", htmlType)

  const $new = cheerio.load("")
  $new("body").append(content)

  if (htmlType === "document" && attach.length > 0) {
    const attachUrl = new URL.URL($(attach).attr("href").trim(), docUrl)
    const attachName = $(attach).text().trim()

    const attachHtml = await DLAttachment(attachUrl)
    const attachDom = attachHtml("#attachment")
    $new("body").append(attachDom)
    console.log(`[✓] Fetched and inserted attachment: ${attachName}`)
  }

  if (htmlType === "document" && QA.length > 0) {
    console.log(`  [-] Following QA of ${docName}`)
    const QAUrl = new URL.URL($(QA).attr("href").trim(), docUrl)
    const QAName = $(QA).text()
    const QADom = await saveHTML(QAUrl, QAName, null, "QA")
    $new("body").append(QADom)
    console.log(`[✓] Fetched and inserted QA: ${QAName}`)
  }

  if (!docPath) {
    return $new("#" + htmlType)
  }

  const parentPath = path.relative(docPath, path.join(staticDir, "CasDoc.css"))
  const cssPath = path.posix.join(...parentPath.split(path.sep))
  $new("head").append(
    `<link rel="stylesheet" href="${cssPath}" type="text/css"/>`
  )

  fs.writeFileSync(docPath, $new.html())
  console.log(`[✓] Fetched and wrote file ${docPath}`)
}

async function main() {
  const utoolsIndex = []
  const sections = [
    ["kuaijizhunzeshishi", "企业会计准则"],
    ["qykjzzjs", "企业会计准则解释"],
    ["qitgd", "其他规定"],
    ["srzzzq", "应用案例"],
    ["sswd", "实施问答"]
  ]

  const getIdxTaskQueue = sections.map(async ([sec, secName]) => {
    const idx = await getIndex(sec, secName)
    utoolsIndex.push(...idx)
  })
  await Promise.all(getIdxTaskQueue)

  console.log(`[✓] Generated indexes: ${utoolsIndex.length}`)
  console.log("=".repeat(15))

  const getPgTaskQueue = utoolsIndex.map(async doc => {
    await saveHTML(doc.url, doc.t, doc.p, "document")
    doc.p = path.posix.relative(
      "public",
      path.posix.join(...doc.p.split(path.sep))
    )
  })

  await Promise.all(getPgTaskQueue)
  console.log(`[✓] Downloaded all pages`)

  fs.writeFileSync(path.join(pubDir, "index.json"), JSON.stringify(utoolsIndex))
  console.log(`[✓] Wrote to index.json.`)
}

main()
