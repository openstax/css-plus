const EventEmitter = require('events')
const csstree = require('css-tree')
const chalk = require('chalk')
const assert = require('./misc/assert')
const jqueryXmlns = require('./misc/jquery.xmlns')
const RuleWithPseudos = require('./misc/rule-with-pseudos')
const {getSpecificity, SPECIFICITY_COMPARATOR} = require('./misc/specificity')
const {throwError, throwBug, showWarning, showDebuggerData} = require('./misc/packet-builder')
const ExplicitlyThrownError = require('./misc/x-throw-error')
const UnsupportedFunctionError = require ('./misc/x-unsupported-function-error')
const {simpleConvertValueToString} = require('./misc/ast-tools')

const sourceColor = chalk.dim
let HACK_COUNTER_A = 0
let HACK_COUNTER_B = 0

const Promise_all = (promises, defaultRet = null) => {
  // remove any nulls
  const real = promises.filter(p => p)
  if (real.length > 0) {
    return Promise.all(real)
  } else {
    return defaultRet
  }
}

// It is expensive to call $el.find() and friends. Since the DOM does not change, just remember what was returned
// This occurs frequently for making counters
function memoize(el, key, value, fn) {
  el[key] = el[key] || {}
  if (typeof el[key][value] === 'undefined') {
    el[key][value] = fn()
  // } else {
  //   console.log(`SAVING TIME AND MONEY WITH MEMOIZATION!!!!!!!!!!!!!!!!!!! ${key} ${value}`);
  }
  return el[key][value]
}

function walkDOMElementsInOrder(el, fn) {
  fn(el)
  if (el.firstElementChild) {
    walkDOMElementsInOrder(el.firstElementChild, fn)
  }
  if (el.nextElementSibling) {
    walkDOMElementsInOrder(el.nextElementSibling, fn)
  }
}

// css-tree parses css arguments a little oddly.
// For example the args in this expression are a single list of length 5:
// foo('a' 'b', 'c' 'd')
//
// This function returns [ ['a', 'b'], ['c', 'd'] ]
function splitOnCommas(args) {
  const ret = []
  let index = 0
  ret[index] = []
  args.forEach((arg) => {
    switch (arg.type) {
      case 'Operator': // comma TODO: Group items based on this operator
        index += 1
        ret[index] = []
        break
      case 'String':
      case 'Identifier':
      case 'WhiteSpace':
      case 'Raw':
      case 'Function':
        ret[index].push(arg)
        break
      case 'HexColor': // for things like `color: #ccc;`
      case 'Dimension': // for things like `.5em`
      case 'Number':
      case 'Percentage':
      case 'Url':
        ret[index].push(arg)
        break
      default:
        throwBug(`Unsupported value type "${arg.type}"`, arg)
    }
  })
  // If we didn't add anything then this must be 0-arguments
  if (ret.length === 1 && ret[0].length === 0) {
    return []
  }
  return ret

}


module.exports = class Applier extends EventEmitter {
  constructor(document, $, options) {
    super()
    // Add the jquery.xmlns plugin so we can select on attributes like epub:type
    // But only add it when the CSS file has @namespace in it. Otherwise, it just adds to execution time
    // jqueryXmlns(document, $)
    // $.xmlns.epub = 'http://www.idpf.org/2007/ops'

    this._pseudoElementPlugins = []
    this._ruleDeclarationPlugins = []
    this._functionPlugins = []
    this._pseudoClassPlugins = []
    this._ruleDeclarationByName = {}
    // This is a HACK until we can use real pseudo elements
    this._pseudoElementPluginByName = {}
    this._pseudoClassPluginByName = {}

    this._document = document
    this._$ = $
    this._options = options || {}

    this._autogenClassNameCounter = 0
    this._unprocessedRulesAndClassNames = {}
  }

  // getWindow() { return this._document.defaultView }
  getRoot() { return this._document.documentElement }

  setCSSContents(css, sourcePath) {
    this._cssContents = css
    this._cssSourcePath = sourcePath
  }

  addPseudoElement(plugin) {
    assert.equal(typeof plugin.selectorReducer, 'function')
    assert.equal(typeof plugin.nodeCreator, 'function')
    assert.equal(typeof plugin.getPseudoElementName, 'function')
    assert.equal(typeof plugin.getPseudoElementName(), 'string')
    this._pseudoElementPlugins.push(plugin)
    this._pseudoElementPluginByName[plugin.getPseudoElementName()] = plugin
  }

  addRuleDeclaration(plugin) {
    assert.equal(typeof plugin.evaluateRule, 'function')
    assert.equal(typeof plugin.getRuleName(), 'string')
    this._ruleDeclarationPlugins.push(plugin)
    this._ruleDeclarationByName[plugin.getRuleName()] = plugin
  }

  addFunction(plugin) {
    assert.equal(typeof plugin.evaluateFunction, 'function')
    assert.equal(typeof plugin.getFunctionName(), 'string')
    this._functionPlugins.push(plugin)
  }

  addPseudoClass(plugin) {
    assert.equal(typeof plugin.matches, 'function')
    assert.equal(typeof plugin.getPseudoClassName, 'function')
    assert.equal(typeof plugin.getPseudoClassName(), 'string')
    this._pseudoClassPlugins.push(plugin)
    this._pseudoClassPluginByName[plugin.getPseudoClassName()] = plugin
  }

  prepare(rewriteSourceMapsFn) {
    let ast = csstree.parse(this._cssContents.toString(), {positions: true, filename: this._cssSourcePath, onParseError: (err) => {
      // Formatted to "look like" an AST node. Just for error-reporting
      const cssSnippet = {
        loc: {
          source: this._cssSourcePath,
          start: {line: err.line, column: err.column}
        }
      }
      throwError(`Problem parsing CSS. ${err.message}`, cssSnippet, null, err)
    }})
    this._ast = ast

    if (rewriteSourceMapsFn) {
      // TODO: Optimization: Only rewrite nodes needed for serializing (and add a flag that it was rewritten)
      rewriteSourceMapsFn(ast)
    }

    // Walking the DOM and calling el.matches(sel) for every selector is inefficient. (causes crash after 7min for big textbook)
    // document.querySelectorAll(sel) is MUCH faster.
    // So, annotate the DOM first with all the matches and then walk the DOM
    assert.equal(ast.type, 'StyleSheet', ast, null)
    let total = 0
    ast.children.each((rule) => {
      // if not a rule then return
      if (rule.type === 'Atrule') {
        switch (rule.name) {
          case 'import':
            // this is included in the vanilla CSS so no need to warn
            break
          case 'namespace':
            assert.is(rule.prelude, rule, null)
            assert.equal(rule.prelude.type, 'AtrulePrelude', rule.prelude, null)
            const args = rule.prelude.children.toArray()
            assert.equal(args.length, 3)
            assert.equal(args[0].type, 'Identifier', args[0])
            assert.equal(args[1].type, 'WhiteSpace', args[1])

            const nsPrefix = args[0].name
            let ns
            switch (args[2].type) {
              case 'Url':
                assert.equal(args[2].value.type, 'String')
                ns = args[2].value.value
                break
              case 'String':
                ns = args[2].value
                break
              default:
                throwError('Malformed namespace declaration', rule)
            }
            ns = ns.substring(1, ns.length - 1) // Strip the quotes off the URL
            // only add jquery.xmlns when @namespace is used in the CSS
            // Add the jquery.xmlns plugin so we can select on attributes like epub:type
            if (!this._$.xmlns) {
              jqueryXmlns(this._document, this._$)
            }
            // $.xmlns.epub = 'http://www.idpf.org/2007/ops'
            this._$.xmlns[nsPrefix] = ns
            break
          default:
            showWarning('Unrecognized at-rule. Skipping processing but including in the output', rule)
            return
        }
        return
      }
      assert.equal(rule.type, 'Rule')
      assert.is(rule.prelude, rule, null)
      assert.equal(rule.prelude.type, 'SelectorList')
      rule.prelude.children.each((selector) => {
        assert.equal(selector.type, 'Selector')
        total += 1
      })
    })

    // Cache matched nodes because selectors are duplicated in the CSS
    const selectorCache = {}

    // const bar = new ProgressBar(`${chalk.bold('Matching')} :percent ${sourceColor(this._options.debug ? ':elapsed' : ':etas')} ${chalk.green("':selector'")} ${sourceColor(':sourceLocation')}`, { total: total})
    this.emit('PROGRESS_START', {type: 'MATCHING', total: total})

    // This code is not css-ish because it does not walk the DOM
    ast.children.each((rule) => {
      // if not a rule then return
      if (rule.type === 'Atrule') {
        return
      }
      assert.equal(rule.type, 'Rule')
      rule.prelude.children.each((selector) => {
        assert.equal(selector.type, 'Selector')
        const browserSelector = this.toBrowserSelector(selector)

        // bar.tick({selector: browserSelector, sourceLocation: this._options.verbose ? cssSnippetToString(selector) : ' '})
        this.emit('PROGRESS_TICK', {type: 'MATCHING', selector: browserSelector, sourceLocation: selector.loc})

        selectorCache[browserSelector] = selectorCache[browserSelector] || this._$(browserSelector)
        let $matchedNodes = selectorCache[browserSelector]
        selector.__COVERAGE_COUNT = $matchedNodes.length

        $matchedNodes = this._filterByPseudoClassName($matchedNodes, selector, -1/*depth*/)

        if ($matchedNodes.length === 0) {
          const selectorChildren = selector.children.toArray()
          // use the last one. to have a more precise location
          showWarning('Unused selector', selectorChildren[selectorChildren.length - 1])
        }

        $matchedNodes.each((index, el) => {
          el.MATCHED_RULES = el.MATCHED_RULES || []
          el.MATCHED_RULES.push({rule, selector})
          el.__COVERAGE_COUNT = el.__COVERAGE_COUNT || 0
          el.__COVERAGE_COUNT += 1
        })
      })
    })
    this.emit('PROGRESS_END', {type: 'MATCHING'})

    // TODO: Does this actually clear up memory?
    // Clear up some memory by removing all the memoizedQueries that jsdom added for caching:
    // This is a little hacky but it works
    // walkDOMElementsInOrder(this._document.documentElement, (el) => {
    //   if (el[Object.getOwnPropertySymbols(el)[0]]) {
    //     el[Object.getOwnPropertySymbols(el)[0]]._clearMemoizedQueries()
    //   }
    // })
  }

  _isPseudoElementSelectorElement(selectorElement) {
    if(selectorElement.type !== 'PseudoElementSelector') {
      return false
    }
    return !! this._pseudoElementPluginByName[selectorElement.name]
  }

  _isPseudoClassSelectorElement(selectorElement) {
    if(selectorElement.type !== 'PseudoClassSelector') {
      return false
    }
    return !! this._pseudoClassPluginByName[selectorElement.name]
  }

  _isRuleDeclarationName(name) {
    return !! this._ruleDeclarationByName[name]
  }

  _filterByPseudoClassName($matchedNodes, selector, startDepth) {
    let depth = -1
    const browserSelectorElements = []
    const pseudoClassElements = []
    selector.children.toArray().forEach((selectorElement) => {
      if (selectorElement.type === 'PseudoElementSelector') {
        depth += 1
      } else if (selectorElement.type === 'PseudoClassSelector') {
        if (startDepth === depth) {
          if (this._isPseudoClassSelectorElement(selectorElement)) {
            pseudoClassElements.push(selectorElement)
          } else {
            browserSelectorElements.push(selectorElement)
          }
        } else if (depth <= -1 && -1 === startDepth) {
          browserSelectorElements.push(selectorElement)
        }
      } else if (depth <= -1 && -1 === startDepth) {
        // include all of the "vanilla" selectors like #id123 or .class-name or [href]
        browserSelectorElements.push(selectorElement)
      }
    })

    const browserSelector = browserSelectorElements.map((selectorElement) => {
      return this.toBrowserSelector2(selectorElement)
    }).join('')

    if (startDepth >= 0 && browserSelector) { // it could be an empty string
      if ($matchedNodes.length === 1) {
        $matchedNodes = memoize($matchedNodes[0], '_filter', browserSelector, () => {
          return $matchedNodes.filter(browserSelector)
        })
      } else {
        $matchedNodes = $matchedNodes.filter(browserSelector)
      }

    }

    // Perform additional filtering only if there are nodes to filter on
    if ($matchedNodes.length >= 1) {
      pseudoClassElements.forEach((pseudoClassElement) => {
        this._pseudoClassPlugins.forEach((pseudoClassPlugin) => {
          if (pseudoClassPlugin.getPseudoClassName() === pseudoClassElement.name) {
            // update the set of matched nodes
            $matchedNodes = $matchedNodes.filter((index, matchedNode) => {
              const $matchedNode = this._$(matchedNode)
              const context = {$contextEl: $matchedNode}
              const args = this._evaluateVals(context, $matchedNode, splitOnCommas(pseudoClassElement.children.toArray()))
              return pseudoClassPlugin.matches(this._$, $matchedNode, args, pseudoClassElement)
            })
          }
        })

      })
    }
    return $matchedNodes
  }

  _evaluateVals(context, $currentEl, vals) {
    return vals.map((argTmp) => {
      return argTmp.map((arg) => {
        switch (arg.type) {
          case 'String':
            // strip off the leading and trailing quote characters
            return arg.value.substring(1, arg.value.length - 1)
          case 'Identifier':
            return arg.name
          case 'WhiteSpace':
            return ''
          case 'Operator': // comma TODO: Group items based on this operator
            throwBug('All of these commas should have been parsed out by now', arg)
            break
          case 'Raw': // The value of this is something like `href, '.foo'`
            // // Make it Look like multitple args
            // const rawArgs = arg.value.split(', ')
            // // I'm not really sure about this if test
            // if (rawArgs.length > 1) {
            //   rawArgs.forEach((rawArg) => {
            //     ret[index].push(rawArg)
            //     index += 1
            //     ret[index] = [] // FIXME: This leaves a trailing empty Array.
            //   })
            // } else {
            //   ret[index].push(rawArg)
            // }

            // Too complex to parse because commas can occur inside selector strings so punt
            return arg.value
          case 'Function':
            const theFunction = this._functionPlugins.filter((fnPlugin) => arg.name === fnPlugin.getFunctionName())[0]
            if (!theFunction) {
              throw new UnsupportedFunctionError(`Unsupported function named ${arg.name}`, arg, $currentEl)
            }
            const fnReturnVal = theFunction.evaluateFunction(this._$, context, $currentEl, this._evaluateVals.bind(this), splitOnCommas(arg.children.toArray()), arg /*AST node*/)
            if (!(typeof fnReturnVal === 'string' || typeof fnReturnVal === 'number' || (typeof fnReturnVal === 'object' && typeof fnReturnVal.appendTo === 'function'))) {
              throwBug(`CSS function should return a string or number. Found ${typeof fnReturnVal} while evaluating ${theFunction.getFunctionName()}.`, arg, $currentEl)
            }
            return fnReturnVal // Should not matter if this is context or newContext
          case 'HexColor':
            return `#${arg.value}`
          case 'Dimension':
            return `${arg.value}${arg.unit}`
          case 'Number':
            return arg.value
          case 'Percentage':
            return `${arg.value}%`
          case 'Url':
            // Throw an exception here so that the `content: url("foo.png")` is not evaluated.
            throw new UnsupportedFunctionError(`Unsupported function named URL`, arg, $currentEl)
          default:
            throwBug('Unsupported evaluated value type ' + arg.type, arg)
        }

      })
    })
    return ret

  }

  _newClassName() {
    this._autogenClassNameCounter += 1
    return `-css-plus-autogen-${this._autogenClassNameCounter}`
  }

  _addVanillaRules(declarationsMap) {
    let declarations = []
    const autogenClassNames = []
    Object.values(declarationsMap).forEach((decls) => {
      decls.forEach((declaration) => {
        declarations.push(declaration)
      })
    })
    declarations = declarations.sort(SPECIFICITY_COMPARATOR)
    declarations.forEach((declaration) => {
      const {selector, astNode} = declaration
      const hash = `${csstree.translate(selector)} {{ ${csstree.translate(astNode)} }}`

      if (this._unprocessedRulesAndClassNames[hash]) {
        autogenClassNames.push(this._unprocessedRulesAndClassNames[hash].className)
      } else {
        const className = this._newClassName()
        this._unprocessedRulesAndClassNames[hash] = {
          className,
          declaration
        }
        autogenClassNames.push(className)
      }
    })
    return autogenClassNames.join(' ')
  }

  getVanillaRules() {
    const atRules = this._ast.children.toArray().filter((rule) => rule.type === 'Atrule')
    const children = atRules.concat(Object.values(this._unprocessedRulesAndClassNames).map(({className, declaration: {selector, astNode}}) => {
      return {
        type: 'Rule',
        loc: astNode.loc,
        prelude: {
          type: 'SelectorList',
          loc: null,
          children: [{
            type: 'Selector',
            loc: {
              source: selector.loc.source,
              start: {
                line: selector.loc.start.line,
                column: selector.loc.start.column + 1,
              }
            },
            children: [{
              type: 'ClassSelector',
              loc: {
                source: selector.loc.source,
                start: {
                  line: selector.loc.start.line,
                  column: selector.loc.start.column + 1,
                }
              },
              name: className
            }]
          }]
        },
        block: {
          type: 'Block',
          loc: astNode.loc,
          children: [astNode]
        }
      }
    }))
    const stylesheetAst = csstree.fromPlainObject({
      type: 'StyleSheet',
      loc: null,
      children: children
    })
    return stylesheetAst
  }

  _evaluateRules(depth, rules, $currentEl, $elPromise, $debuggingEl) {

    if ($debuggingEl.attr('data-debugger')) {
      debugger
    }

    // Pull out all the declarations for this rule, and then later sort by specificity.
    // The structure is {'content': [ {specificity: [1,0,1], isImportant: false}, ... ]}
    const declarationsMap = {}
    const debugMatchedRules = []
    const debugAppliedDeclarations = []
    const debugSkippedDeclarations = []
    const ruleDeclarationsByName = {}

    // TODO: Decide if rule declarations should be evaluated before or after nested pseudoselectors
    rules.forEach((matchedRule, index) => {
      // Only evaluate rules that do not have additional pseudoselectors (more depth available)
      if (matchedRule.getDepth() - 1 === depth) {
        debugMatchedRules.push(matchedRule)
        matchedRule.getRule().rule.block.children.toArray().forEach((declaration) => {
          const {type, important, property, value} = declaration

          if (!this._isRuleDeclarationName(property)) {
            if (this._options.verbose) {
              showWarning(`Skipping because I do not understand the rule '${property}'. Maybe a typo?`, value, $currentEl)
            }
            declaration.__COVERAGE_COUNT = declaration.__COVERAGE_COUNT || 0 // count that it was not covered
          }
          declarationsMap[property] = declarationsMap[property] || []
          declarationsMap[property].push({value, specificity: getSpecificity(matchedRule.getMatchedSelector(), depth, index), isImportant: important, selector: matchedRule.getMatchedSelector(), astNode: declaration})
        })
      }
    })

    const doStuff = (ruleDeclarationPlugin, declarations) => {
      if (declarations) {
        declarations = declarations.sort(SPECIFICITY_COMPARATOR)
        // use the last declaration because that's how CSS works; the last rule (all-other-things-equal) wins
        const {value, specificity, isImportant, selector, declaration} = declarations[declarations.length - 1]
        // Log that other rules were skipped because they were overridden
        declarations.slice(0, declarations.length - 1).forEach((declaration) => {
          const {value} = declaration
          // BUG: Somehow the same selector can be matched twice for an element . This occurs with the `:not(:has(...))` ones
          showWarning(`Skipping because this was overridden by `, value, $currentEl, /*additional CSS snippet*/declarations[declarations.length - 1].value)
          declaration.astNode.__COVERAGE_COUNT |= 0

          const unevaluatedVals = value.children.map((val) => simpleConvertValueToString(val))
          debugSkippedDeclarations.push({declaration, unevaluatedVals})
        })

        if (value) {
          const declaration = declarations[declarations.length - 1]
          declaration.astNode.__COVERAGE_COUNT = declaration.astNode.__COVERAGE_COUNT || 0
          declaration.astNode.__COVERAGE_COUNT += 1

          let vals
          try {
            vals = this._evaluateVals({$contextEl: $currentEl}, $currentEl, splitOnCommas(value.children.toArray()))

          } catch (err) {
            if (err instanceof UnsupportedFunctionError) {
                return err
            } else {
              // Error was already logged so just throw it
              // throwError(err.message, value, $currentEl, err)
              throw err
            }
          }
          debugAppliedDeclarations.push({declaration, vals})
          try {
            return ruleDeclarationPlugin.evaluateRule(this._$, $currentEl, $elPromise, vals, value)
          } catch (e) {
            if (e instanceof ExplicitlyThrownError) {
              throw e
            } else {
              throwBug(`Problem while evaluating rule "${ruleDeclarationPlugin.getRuleName()}:". Message was "${e.message}"`, value, $currentEl, e)
            }
          }
        } else {
          return null // Nothing to do so no Promise
        }
      } else {
        return null // Nothing to do so no Promise
      }
    }

    // now that all the declarations are sorted by selectivity (and filtered so they only occur once)
    // apply the declarations
    const promises = this._ruleDeclarationPlugins.map((ruleDeclarationPlugin) => {
      let declarations = declarationsMap[ruleDeclarationPlugin.getRuleName()]
      const ret = doStuff(ruleDeclarationPlugin, declarations)
      if (ret instanceof UnsupportedFunctionError) {
        // use the || clause when the function is `url("foo.png")`
        showWarning(`Skipped declaration containing unsupported function "${ret.astNode.name || ret.astNode.type}(...)"`, ret.astNode, ret.$el)
        return null
      } else {
        // remove it when it is processed. Anything remaining will be output to CSS
        delete declarationsMap[ruleDeclarationPlugin.getRuleName()]
      }
      return ret
    })

    // Any remaining declarations will be output in the CSS file but we need to add a class to the elements
    if (Object.keys(declarationsMap).length !== 0) {

      const autogenClassNames = this._addVanillaRules(declarationsMap)

      Object.values(declarationsMap).forEach((declarations) => {
        declarations.forEach((declaration) => {
          declaration.astNode.__COVERAGE_COUNT = declaration.astNode.__COVERAGE_COUNT || 0
          declaration.astNode.__COVERAGE_COUNT += 1
        })
      })

      promises.push($elPromise.then(($el) => {
        $el.addClass(autogenClassNames)
        return $el
      }))
    }

    if ($debuggingEl.attr('data-debugger')) {
      showDebuggerData($currentEl, debugMatchedRules, debugAppliedDeclarations, debugSkippedDeclarations, $debuggingEl, this.toBrowserSelector.bind(this))
    }

    return Promise_all(promises)
  }


  toBrowserSelector(selector, includePseudoElements) {
    assert.equal(selector.type, 'Selector')
    // Stop processing at the first PseudoElement
    const ret = []
    let foundPseudoElement = false

    selector.children.toArray().forEach((sel) => {
      if (!includePseudoElements && this._isPseudoElementSelectorElement(sel)) {
        foundPseudoElement = true
      } else if (!foundPseudoElement) {
        ret.push(this.toBrowserSelector2(sel, includePseudoElements))
      }
    })
    return ret.join('')
  }

  toBrowserSelector2(sel, includePseudoElements) {
    switch (sel.type) {
      case 'Universal':
        return sel.name
      case 'TypeSelector':
        return sel.name
      case 'IdSelector':
        return `#${sel.name}`
      case 'ClassSelector':
        return `.${sel.name}`
      case 'WhiteSpace':
        return sel.value
      case 'Combinator':
        if (sel.name === ' ') {
          return ' '
        } else {
          return ` ${sel.name} `
        }
      case 'AttributeSelector':
        const name = sel.name
        const value = sel.value
        let nam
        switch (name.type) {
          case 'Identifier':
            nam = name.name
            break
          default:
            console.log(JSON.stringify(sel))
            throwBug(`Unmatched nameType=${name.type}`, name)
        }
        let val
        if (value) {
          assert.is(sel.matcher, sel, null, 'AttributeSelector is missing an operator/matcher')
          switch (value.type) {
            case 'String': // `[data-type="foo"]`
              val = value.value
              break
            case 'Identifier':  // `[data-type=foo]`
              val = value.name
              break
            default:
              console.log(JSON.stringify(sel))
              throwBug(`Unmatched valueType=${value.type}`, value)
          }
          return `[${nam}${sel.matcher}${val}]`
        } else {
          return `[${nam}]`
        }

      case 'PseudoClassSelector':
        // Discard some but not all. For example: keep `:not(...)` but discard `:pass(1)`
        switch (sel.name) {
          // discard these
          case 'pass':
          case 'deferred':
          case 'match':
          case 'first-of-type':
          case 'target': // this is new
            if (includePseudoElements) {
              if (sel.children) {
                const children = sel.children.map((child) => {
                  if (child.type === 'Raw') {
                    return child.value
                  } else {
                    assert.equal(child.type, 'SelectorList')
                    return child.children.map((child) => this.toBrowserSelector(child, includePseudoElements)).join(', ')
                  }
                })
                return `:${sel.name}(${children})`
              } else {
                return `:${sel.name}`
              }
            } else {
              return ''
            }
          // keep these
          case 'not-has': // This was added because SASS has a bug and silently drops `:not(:has(foo))`. A more-hacky way would be to write `:not(:not(SASS_HACK):has(foo))`
            assert.is(sel.children)
            const children = sel.children.map((child) => {
              assert.equal(child.type, 'Raw')
              return child.value
            })
            return `:not(:has(${children.join(',')}))`
          case 'has':
          case 'last-child':
          case 'not':
          case 'first-child': // Just vanilla CSS, not tested yet
          case 'first-of-type':
          case 'last-of-type':
          case 'only-of-type':
          case 'only-child':
            if (sel.children) {
              const children = sel.children.map((child) => {
                assert.is(child.type, 'SelectorList', child)
                return child.children.map((child) => this.toBrowserSelector(child, includePseudoElements)).join(', ')
              })
              return `:${sel.name}(${children})`
            } else {
              return `:${sel.name}`
            }

          // from https://github.com/jquery/sizzle/wiki
          case 'nth-child':
          case 'nth-of-type': // Just vanilla CSS, not tested yet
          case 'nth-last-of-type':
            const nthChildren = sel.children.map((child) => {
              assert.equal(child.type, 'Nth', child)
              switch (child.nth.type) {
                case 'AnPlusB':
                  const {a, b} = child.nth
                  if (a && b) {
                    return `${a}n+${b}`
                  } else if (a) {
                    return `${a}n`
                  } else if (b) {
                    return b
                  } else {
                    throwBug(`Unsupported An+B syntax`, child)
                  }
                case 'Identifier':
                  return child.nth.name
                default:
                  throwBug(`Unsupported nth syntax`, child)
              }
            })
            return `:${sel.name}(${nthChildren.join(', ')})` // not sure if adding the comma is correct
          default:
            throwError(`Unsupported Pseudoclass ":${sel.name}"`, sel)
        }

      case 'PseudoElementSelector':
        // Discard some of these because sizzle/browser does no recognize them anyway (::outside or :after(3))
        switch (sel.name) {
          // Discard these
          case 'after':
          case 'before':
          case 'outside':
          case 'inside':
          case 'for-each-descendant':
          case 'deferred': // Hack for parsing the book.css file // FIXME by removing
            if (includePseudoElements) {
              if (sel.children) {
                const children = sel.children.map((child) => {
                  if (child.type === 'Raw') {
                    return child.value
                  } else {
                    assert.equal(child.type, 'SelectorList')
                    return child.children.map((child) => this.toBrowserSelector(child, includePseudoElements)).join(', ')
                  }
                })
                return `::${sel.name}(${children})`
              } else {
                return `::${sel.name}`
              }
            } else {
              return ''
            }

          case 'footnote-marker':
          case 'footnote-call':
          case 'marker':
            // TODO: This should somehow be ignored (not returned) and marked for the vanilla CSS file
            return ''
          default:
            throwBug(`Unsupported Pseudoelement "::${sel.name}"`, sel)
        }
      default:
        console.log(JSON.stringify(sel))
        throwBug(`Unsupported Selector type=${sel.type} name=${sel.name}`, sel)
    }
  }

  run(fn) {
    let total = 0
    walkDOMElementsInOrder(this._document.documentElement, (el) => {
      total += 1
    })


    // const bar = new ProgressBar(`${chalk.bold('Converting')} :percent ${sourceColor(this._options.debug ? ':elapsed' : ':etas')} [${chalk.green(':bar')}] #:current ${sourceColor(':sourceLocation')}`, {
    //   renderThrottle: 200,
    //   complete: '=',
    //   incomplete: ' ',
    //   width: 40,
    //   total: total
    // })
    this.emit('PROGRESS_START', {type: 'CONVERTING', total: total})

    let ticks = 0
    const allPromises = []
    walkDOMElementsInOrder(this._document.documentElement, (el) => {
      // Do not bother showing the source location for elements that did not match anything
      // bar.tick({ sourceLocation: (el.MATCHED_RULES && this._options.verbose) ? htmlLocation(el) : '' })
      ticks += 1
      if (ticks >= total / 1000) {
        this.emit('PROGRESS_TICK', {type: 'CONVERTING', ticks: ticks})
        ticks = 0
      }

      const matches = el.MATCHED_RULES || []
      el.MATCHED_RULES = null
      delete el.MATCHED_RULES // Free up some memory
      const promise = fn(this._$(el), matches)
      if (promise) {
        allPromises.push(promise)
      }
    })
    // assert.is(allPromises.length > 0)
    if (ticks > 0) {
      this.emit('PROGRESS_TICK', {type: 'CONVERTING', ticks: ticks})
    }
    this.emit('PROGRESS_END', {type: 'CONVERTING', promise_count: allPromises.length})
    return allPromises
  }

  process() {
    const allPseudoElementNames = this._pseudoElementPlugins.map((plugin) => plugin.getPseudoElementName())
    const allElementPromises = this.run(($el, rules) => {
      const $debuggingEl = $el // used for the data-debugger to know which DOM node to check if debugging is enabled
      if (rules.length > 0) {

        // Allow pausing the engine when an element has `data-debugger="true"` set
        if ($el.attr('data-debugger')) {
          debugger
        }

        const rulesWithPseudos = rules.map((rule) => new RuleWithPseudos(rule, allPseudoElementNames))

        // Recursively walk through the pseudoelements (::after::before(3)::after)
        // from left-to-right, creating new nodes along the way.
        // TODO: delay creating the nodes (or at least appending them to the DOM)
        // until other evaluations have finished.
        const recursePseudoElements = (depth, rulesWithPseudos, $lookupEl, $contextElPromise) => {

          // TODO: Fix this annoying off-by-one error
          const rulesAtDepth = rulesWithPseudos.filter((matchedRuleWithPseudo) => {
            // Check if additional pseudoClasses have caused this to end prematurely.
            // For example: `::for-each-descendant('section'):has(exercise)::....`
            // will stop evaluating if the `section` does not contain an `exercise`
            if (0 === this._filterByPseudoClassName($lookupEl, matchedRuleWithPseudo.getMatchedSelector(), depth-1).length) {
              return false
            }

            return matchedRuleWithPseudo.hasDepth(depth)
          })

          if (rulesAtDepth.length === 0) {
            return
          }

          return Promise_all(this._pseudoElementPlugins.map((pseudoElementPlugin) => {
            const pseudoElementName = pseudoElementPlugin.getPseudoElementName()

            const matchedRulesAtDepth = rulesAtDepth.filter((rule) => {
              return rule.getPseudoAt(depth).name === pseudoElementName
            })
            const reducedRules = pseudoElementPlugin.selectorReducer(matchedRulesAtDepth, depth)
            // const $contextElPromise = Promise.resolve($contextEls)
            const newElementsAndContexts = pseudoElementPlugin.nodeCreator(this._$, reducedRules, $lookupEl, $contextElPromise, depth)


            // Zip up the reducedRules with the new DOM nodes that were created and recurse
            assert.equal(reducedRules.length, newElementsAndContexts.length)
            const allPromises = []
            for (let index = 0; index < reducedRules.length; index++) {
              const promises = newElementsAndContexts[index].map(({$newElPromise, $newLookupEl}) => {

                // $newElPromise.then(($newEl) => {
                //   if(!$newEl.parents(':last').is('html')) {
                //     throwBug(`provided element is not attached to the DOM`, null, $newEl)
                //   }
                //   return $newEl
                // })

                // This loop-and-check is here to support ::for-each-descendant(1, 'section'):has('exercise.homework')
                const rulesAtDepth = reducedRules[index].filter((matchedRuleWithPseudo) => {
                  // Check if additional pseudoClasses have caused this to end prematurely.
                  // For example: `::for-each-descendant('section'):has(exercise)::....`
                  // will stop evaluating if the `section` does not contain an `exercise`
                  if (0 === this._filterByPseudoClassName($newLookupEl, matchedRuleWithPseudo.getMatchedSelector(), depth).length) {
                    return false
                  }
                  return matchedRuleWithPseudo.hasDepth(depth)
                })
                if (rulesAtDepth.length == 0) {
                  return null // skip the evaluation
                }

                return Promise_all([
                  this._evaluateRules(depth, reducedRules[index], $newLookupEl, $newElPromise, $debuggingEl),
                  recursePseudoElements(depth + 1, reducedRules[index], $newLookupEl, $newElPromise)
                ])

              })
              allPromises.push(Promise_all(promises))
            }
            return Promise_all(allPromises)

          }))
        }
        // Start the evaluation
        const $elPromise = Promise.resolve($el)
        return Promise_all([
          recursePseudoElements(0, rulesWithPseudos, $el, $elPromise),
          this._evaluateRules(-1 /*depth*/, rulesWithPseudos, $el, $elPromise, $el)
        ])
      }

    })
    return Promise_all(allElementPromises, Promise.resolve('Nothing to process'))
  }
}