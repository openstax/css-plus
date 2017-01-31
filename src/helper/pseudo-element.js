const assert = require('assert')
const {throwError} = require('./error')

// Every pseudoelement results in 1 (or more) elements being created.
// The order in which they are created matters.
// Start with a simple `::after`:

// ($contextEls) => {
//   const el = document.createElement('div')
//   $contextEls.appendChild(el)
//   return el
// }

// Now, add multiple `::after(N)` and make sure they are added properly


function getIndex(ruleWithPseudo, depth) {
  const {firstArg: arg} = ruleWithPseudo.getPseudoAt(depth)
  let index
  if (arg) {
    assert.equal(arg.type, 'Number')
    index = Number.parseInt(arg.value) // arg.value is a String
  } else {
    index = 1
  }
  return index
}


module.exports = class PseudoElementEvaluator {
  constructor(pseudoName, creator) {
    this._pseudoName = pseudoName
    this._creator = creator
  }

  getPseudoElementName() { return this._pseudoName }

  // selectorReducer([1, 4, null, 2, *]) -> [ [1,null,*], [2,*], [4,*] ]
  selectorReducer(rulesWithPseudos, depth) {

    // Sort all the selectors
    rulesWithPseudos = rulesWithPseudos.sort((rule1, rule2) => {
      const index1 = getIndex(rule1, depth)
      const index2 = getIndex(rule2, depth)
      return index1 - index2
    })

    const ret = []
    let mostRecentIndex = 0
    let retIndex = -1
    rulesWithPseudos.forEach((ruleWithPseudo) => {
      const {firstArg: arg} = ruleWithPseudo.getPseudoAt(depth)
      const myIndex = getIndex(ruleWithPseudo, depth)

      if (myIndex !== mostRecentIndex) {
        mostRecentIndex = myIndex
        retIndex++
      }
      ret[retIndex] = ret[retIndex] || []
      ret[retIndex].push(ruleWithPseudo)
    })
    return ret
  }

  nodeCreator($, reducedSelectors, $lookupEl, $contextEls, depth) {
    return reducedSelectors.map((selectors) => {
      // Some pseudoelement selectors have an additional arg (like ::for-each)
      // HACK: Just use the 2nd arg of the first-found pseudo-selector. Eventually, loop over all selectors, find the unique 2ndargs, and run this._creator on them
      const {secondArg} = selectors[0].getPseudoAt(depth)
      const $newEl = $('<div>')
      $newEl.attr('pseudo', `${this._pseudoName}(${getIndex(selectors[0], depth)})`)
      const ret = this._creator($lookupEl, $contextEls, $newEl, secondArg)

      // validation
      if (!Array.isArray(ret)) {
        throwError(`BUG: node creator returned a non-array while evaluating ${this._pseudoName}`, selectors[0].getRule().rule)
      }
      assert(Array.isArray(ret))
      ret.forEach((item) => {
        assert(item.$newEl)
        assert(item.$newLookupEl)
      })
      return ret
      // return $newEl
    })
  }
}