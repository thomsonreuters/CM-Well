class Infoton {
    constructor({system, fields}, dns) {
        
        this.type = system.type
        this.uuid = system.uuid
        this.path = system.path
        this.system = system
        this.name = AppUtils.lastPartOfUrl(system.path)
        this.fields = _(fields).chain().map((vs,k) => [k,vs.map(v => new FieldValue(v))]).object().value()
        this.displayName = this.inferDisplayName(dns) || this.name
    }
    
    inferDisplayName(dns) {
        if(!this.fields || !dns) return
        
        let typerdf = (this.fields['type.rdf'] || [])[0]
        if(!typerdf) return
        
        let dnObj = dns[md5(typerdf.value)]
        if(!dnObj) return

        let dnFuncsAndVals = _(dnObj).chain()
            .pairs()
            .reject(p => p[0] === 'forType')
            .sortBy(p => p[0])
            .map(p => p[1][0])
            .value()        
        
        // fieldsL and fields are to be used within `eval(code)` below
        let fieldsL = this.fields
        let fields = _(this.fields).chain().pairs().map(p => [p[0],p[1][0]]).object().value()
        
        let apply = function(dnFuncOrVal) {
            if(dnFuncOrVal.indexOf('javascript:')===0) {
                let code = dnFuncOrVal.replace('javascript:','')
                try { return eval(code) } catch(e) { }
            } else {
                return fields[dnFuncOrVal]
            }
        }

        let result = _(dnFuncsAndVals).chain().map(apply).find(_.identity).value()
        if(result)
            return result.value
        else
            console.warn(`[DisplayName] Infoton ${this.path} of type ${typerdf.value} has none of the fields [${dnFuncsAndVals.join`,`}]`)
    }
}

class FieldValue {
    constructor({ value, type, quad }) {
        this.value = value
        this.type = type
        this.quad = quad
    }
}

let exports = { Infoton, FieldValue }
define([], () => exports)