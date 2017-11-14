const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const mkdirp = require('mkdirp')
// const jsdom = require('jsdom')
const jquery = require('jquery')
const {SourceMapConsumer} = require('source-map')

const converter = require('../converter')
const {showWarning} = require('./packet-builder')
const renderPacket = require('./packet-render')
const constructSelector = require('./construct-selector')

function toRelative(outputPath, inputPath, contextPath='') {
  return path.relative(path.dirname(path.join(process.cwd(), outputPath)), path.join(process.cwd(), contextPath, inputPath))
}

let browserPromise = null // assigned on 1st attempt to convert

let hasBeenWarned = false
async function convertNodeJS(cssContents, htmlContents, cssPath, htmlPath, htmlOutputPath, options, packetHandler) {
  const htmlSourcePathRelativeToSourceMapFile = toRelative(htmlOutputPath, htmlPath)
  const cssPathRelativeToSourceMapFile = toRelative(htmlOutputPath, cssPath)
  const cssPathRelativeToOutputHtmlPath = path.relative(path.dirname(htmlOutputPath), cssPath)

  const sourceMapPath = `${htmlOutputPath}.map`
  const sourceMapFileName = path.basename(sourceMapPath) // This is used for the value of the sourceMappingURL

  // If the CSS contains namespace declarations then parse the html file as XML (no HTML source line info though)
  const isXhtml = /@namespace/.test(cssContents.toString()) || /xmlns/.test(htmlContents.toString())


  const selectorToLocationMap = {}
  // Build up a mapping from selector to HTML line/column information so we can look it up when using the sourcemaps for messages or for the HTML output
  // if (isXhtml) {
  //   console.log('Setting to XML Parsing mode')
  //   jsdomArgs = {contentType: 'application/xml', /*includeNodeLocations: true*/}
  // } else {
  //   jsdomArgs = {includeNodeLocations: true}
  // }
  // const dom = new jsdom.JSDOM(htmlContents, jsdomArgs)
  // const {window} = dom
  // const {document} = window
  // // Traverse the document ()
  // count = 0
  // function walkDOMElementsInOrder(el, index, acc, fn) {
  //   if ((el.tagName.toLowerCase() === 'span' || el.tagName.toLowerCase() === 'div') && el.childNodes.length === 0) {
  //     console.log(`akjdhaksjhdaksjhd SKIPPING ${constructSelector(el)}`);
  //     // skip counting because chrome removes it
  //     // These elements are in the metadata and need to be fixed
  //   } else if (el.getAttribute('data-type') === "cnx-archive-uri") {
  //     console.log(`akjdhaksjhdaksjhd SKIPPING ${constructSelector(el)}`);
  //   } else if (el.getAttribute('data-type') === "cnx-archive-shortid") {
  //     console.log(`akjdhaksjhdaksjhd SKIPPING ${constructSelector(el)}`);
  //   } else {
  //     acc = fn(el, index, acc)
  //     count += 1
  //   }
  //   if (el.firstElementChild) {
  //     walkDOMElementsInOrder(el.firstElementChild, 1, acc, fn)
  //   }
  //   if (el.nextElementSibling) {
  //     walkDOMElementsInOrder(el.nextElementSibling, index + 1, acc, fn)
  //   }
  // }
  // walkDOMElementsInOrder(document.documentElement, 1, '', (el, index, acc) => {
  //   const selector = constructSelector(el)
  //   // selectorToLocationMap[selector] = dom.nodeLocation(el)
  //   console.log(`jsdom: ${selector}`);
  // })
  // window.close()
  // console.log('qiweuyqiuwye jsdomcount=' + count);

  const sax = require('sax')
  const parser = sax.parser(true/*strict*/, {xmlns: true, position: true, lowercase: true})

  // Use the sax parser to get source line/column information from the XHTML document
  // TODO: Should automatically verify that the number of SAX elements and Chrome elements
  // matches. That way we can use index numbers to refer to elements instead of these
  // semi-long CSS selectors.
  function constructSelectorSax(prefix, index, tagName, attributes) {
    if (!tagName) {
      throw new Error('BUG: tagName should be non-null')
    } else if (tagName === 'html') {
      return 'html'
    } else if (tagName === 'head') {
      return 'head'
    } else if (tagName === 'body') {
      return 'body'
    } else if (attributes['id']) {
      return `${tagName}#${attributes['id'].value}`
    } else {
      return `${prefix} > ${tagName}:nth-child(${index})`
    }
  }
  const htmlSourceLookupMap = {} // key=selector, value={line, col}
  let saxCount = 0
  let depthCounts = [0]
  let depthSelectorPrefix = ['']
  let currentDepth = 0
  let parserStartTagPosition = null
  let encounteredHeadElement = false
  parser.onopentagstart = () => {
    // remember the line/col from the parser so we can use it instead of the position of the end of the open tag
    parserStartTagPosition = {line: parser.line, column: parser.column}
  }
  parser.onopentag = ({name, attributes, isSelfClosing, local, ns, prefix, uri}) => {
    depthCounts[currentDepth] += 1
    depthCounts[currentDepth + 1] = 0
    const str = constructSelectorSax(depthSelectorPrefix[currentDepth], depthCounts[currentDepth], local, attributes)
    depthSelectorPrefix[currentDepth + 1] = str
    currentDepth += 1
    // console.log(`sax: ${str}`)

    // chrome auto-adds a <head> so increment the count so the checksum matches
    // NOTE: there are other elements that Chrome adds (like <dbody> so this is not a good general solution)
    if (local === 'head') {
      encounteredHeadElement = true
    }
    if (local === 'body' && !encounteredHeadElement) {
      saxCount += 1
    }

    if (local === 'span' && isSelfClosing) {
      // do not count because chrome eats this element
    } else {
      htmlSourceLookupMap[str] = [parserStartTagPosition.line + 1, parserStartTagPosition.column + 1]
      // Count the elements for checksumming later with what Chrome found
      saxCount += 1
    }
  }
  parser.onclosetag = () => {
    delete depthCounts[currentDepth]
    currentDepth -= 1
  }
  parser.onend = () => {
    // console.log('qiweuyqiuwye saxcount=', saxCount);
  }
  parser.write(htmlContents).close()






  // Read in the CSS sourcemap
  let cssSourceMappingURL
  if (!options.nocssmap) {
    const sourceMappingURLMatch = /sourceMappingURL=([^\ \n]+)/.exec(cssContents.toString())
    if (sourceMappingURLMatch) {
      cssSourceMappingURL = sourceMappingURLMatch[1]
    }
  }


  let map
  let cssSourceMapJson
  if (cssSourceMappingURL) {
    const sourceMapURLPath = path.join(path.dirname(cssPath), cssSourceMappingURL)
    try {
      cssSourceMapJson = JSON.parse(fs.readFileSync(sourceMapURLPath).toString())
      // TODO: Fix up all the paths to be relative to the output HTML file.
      //        newStartPath = path.join(path.dirname(cssSourcePath), newStartPath)
      cssSourceMapJson.sources = cssSourceMapJson.sources.map((sourcePath) => {
        return path.join(path.dirname(sourceMapURLPath), sourcePath)
      })
    } catch (e) {
      showWarning(`sourceMappingURL was found in ${cssPath} but could not open the file ${sourceMapURLPath}`)
    }
  }







  if (!browserPromise) {
    const devtools = process.env['NODE_ENV'] == 'debugger'
    const headless = devtools ? false : !options.debug
    browserPromise = puppeteer.launch({headless: headless, devtools: devtools})
  }
  const browser = await browserPromise
  const page = await browser.newPage()

  const url = `file://${path.resolve(htmlPath)}`

  page.on('console', ({type, text}) => {
    if (type === 'warning') {
      console.warn(text)
    } else if (type === 'error') {
      console.error(text)
    } else if (type === 'info') {
      const json = JSON.parse(text)
      if (json.type === 'ELEMENT_COUNT') {
        // assert.equal(saxCount, json.count, `Element count from SAX (to find line/column info) and Chrome (that does the tranform) mismatch. Expected ${saxCount} but got ${json.count}`)
      } else {
        if (packetHandler) {
          packetHandler(json, htmlSourceLookupMap)
        } else {
          const message = renderPacket(json, htmlSourceLookupMap, options)
          if (message) {
            console.log(message)
          }
        }
      }

    } else {
      console.log(text)
    }
  })
  if (options.verbose) {
    console.log(`Opening HTML in Chrome... ${url}`)
  }
  await page.goto(url, {waitUntil: 'networkidle'})
  if (options.verbose) {
    console.log('Opened HTML in Chrome')
  }
  // Inject jQuery and the JS bundle
  // Don't use page.addScriptTag because it keeps the <script> in the DOM.
  // We could probably remove the tag before serializing though.
  //
  await page.evaluate(`(function () {
    if (!document.querySelector('head')) {
      const head = document.createElement('head')
      const firstChild = document.documentElement.firstChild
      if (firstChild) {
        document.documentElement.insertBefore(head, firstChild)
      } else {
        document.appendChild(head)
      }
    }
  })()`)
  await page.addScriptTag({path: require.resolve('jquery')})
  await page.addScriptTag({path: require.resolve('../../dist/browser')})
  await page.evaluate(`(function () {
    document.querySelectorAll('script').forEach((el) => el.remove())
  })()`)
  // await page.evaluate(`(function () { ${fs.readFileSync(require.resolve('jquery'))} })()`)
  // await page.evaluate(`(function () { ${fs.readFileSync(require.resolve('../../dist/browser'))} })()`)

  await page.evaluate(`(function () { window.__HTML_SOURCE_LOOKUP = ${JSON.stringify(htmlSourceLookupMap)}; })()`)
  await page.evaluate(`(function () { window.__CSS_SOURCE_MAP_JSON = ${JSON.stringify(cssSourceMapJson)}; })()`)
  function escaped(str) {
    return str.toString().replace(/\\/g, '\\\\').replace(/`/g, '\\`')
  }


  async function saveCoverage() {
    const istanbulCoverage = await page.evaluate(`window.__coverage__`)
    // Get the code coverage data (if available)
    // Write the headless Chrome coverage data out
    if (istanbulCoverage) {
      // TODO: This should probably not be in this file. it should probably be hoisted into the test files
      mkdirp.sync(path.join(__dirname, `../../.nyc_output/`))
      fs.writeFileSync(path.join(__dirname, `../../.nyc_output/hacky-chrome-stats_${Math.random()}.json`), JSON.stringify(istanbulCoverage))
    }
  }

  if (options.verbose) {
    console.log('Transforming HTML...')
  }
  let ret
  let err

  // CssPlus = (document, $, cssContents, cssSourcePath, htmlSourcePath, consol, htmlSourceLookup, htmlSourceFilename, sourceMapPath, rewriteSourceMapsFn, options)
  try {
    ret = await page.evaluate(`CssPlus(window.document, window.jQuery, \`${escaped(cssContents)}\`, \`${escaped(cssPath)}\`, \`${escaped(htmlPath)}\`, console, function() { return '???sourceLookup123'}, \`${escaped(htmlPath)}\`, \`${escaped(sourceMapFileName)}\`, null, ${JSON.stringify(options)})`)
    await saveCoverage()
    await page.close()
  } catch (e) {
    await saveCoverage()
    await page.close()
    throw e
  }
  if (options.verbose) {
    console.log('Transformed HTML')
  }

  // clean up the new sourcemap and make the paths relative to the output file.
  // earlier the paths were relative to the current directory so error/warning messages would appear properly
  const retSourceMapJson = JSON.parse(ret.sourceMap)
  retSourceMapJson.sources = retSourceMapJson.sources.map((sourcePath) => {
    const ret = path.relative(path.dirname(htmlOutputPath), sourcePath)
    return ret
  })
  ret.sourceMap = JSON.stringify(retSourceMapJson)


  return ret
}



module.exports = {convertNodeJS, finish: () => browserPromise.then((browser) => browser.close() ) }
