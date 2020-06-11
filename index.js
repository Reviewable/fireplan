'use strict';

const _ = require('lodash');
const esprima = require('esprima');
const escodegen = require('escodegen');
const estraverse = require('estraverse');
const clone = require('clone');

const BUILTINS = {
  auth: true, now: true, root: true, next: true, newData: true, prev: true, data: true, env: true,
  query: true
};

const NEW_DATA_VAL = {type: 'CallExpression', arguments: [], callee: {
  type: 'MemberExpression', computed: false, object: {type: 'Identifier', name: 'newData'},
  property: {type: 'Identifier', name: 'val'}
}};


class Compiler {
  constructor(source) {
    this.source = source;
  }

  transform() {
    this.defineFunctions();
    const tree = this.transformBranch(this.source.root, []);
    if (tree['.indexChildrenOn']) {
      throw new Error(
        'Indexed attributes must be nested under a wildard key: ' + tree['.indexChildrenOn']);
    }
    const encryptTree = this.extractEncryptDirectives(tree);
    return {rules: tree, firecrypt: encryptTree};
  }

  defineFunctions() {
    this.source.functions = this.source.functions || [];
    this.source.functions.push(
      {'boolean': 'next.isBoolean()'},
      {'string': 'next.isString()'},
      {'number': 'next.isNumber()'},
      {'any': 'true'}
    );
    this.functions = {};
    _.each(this.source.functions, definition => {
      _.each(definition, (body, signature) => {
        const match = signature.match(/^\s*(\w+)\s*(?:\((.*?)\))?\s*$/);
        if (!match) throw new Error('Invalid function signature: ' + signature);
        const name = match[1];
        const args = _.compact(_.map((match[2] || '').split(','), arg => arg.trim()));
        _.each(args, arg => {
          if (arg in BUILTINS) {
            throw new Error('Argument name "' + arg + '" shadows builtin variable');
          }
        });
        if (name in this.functions) throw new Error('Duplicate function definition: ' + name);
        try {
          this.functions[name] = {name, args, ast: esprima.parse(body).body[0].expression};
        } catch (e) {
          e.message += ' in ' + body;
          throw e;
        }
      });
    });
    let changed = true;
    while (changed) {
      changed = false;
      _.each(this.functions, (fn, name) => {  // eslint-disable-line no-loop-func
        fn.ast = this.transformAst(fn.ast, fn.args);
        changed = changed || this.changed;
      });
    }
  }

  transformBranch(yaml, locals) {
    const json = {};
    if (_.isString(yaml)) yaml = {'.value': yaml};
    const requiredChildren = [], indexedChildren = [];
    let indexedGrandChildren = [];
    let moreAllowed = false, hasWildcard = false;
    _.each(yaml, (value, key) => {
      switch (key) {
        case '.value':
          value = value.replace(/^\s*((required|indexed|encrypted(\[.*?\])?)(\s+|$))*/, '');
          if (value.trim() === 'any') moreAllowed = true;
          /* fall through */
        case '.read':
        case '.write':
        case '.read/write':
          yaml[key] = this.expandExpression(value, locals);
          break;
        case '.more':
          moreAllowed = value;
          break;
        default: {
          const encrypt = {};
          key = key.replace(/\/encrypted(\[.*?\])?(?=\/|$)/, (match, pattern) => {
            encrypt.key = pattern ? pattern.slice(1, -1) : '#';
            return '';
          }).replace(/\/few(?=\/|$)/, () => {
            if (key.charAt(0) !== '$') {
              throw new Error(`/few annotation applies only to $wildcard keys, not to "${key}"`);
            }
            encrypt.few = true;
            return '';
          });
          const firstChar = key.charAt(0);
          if (firstChar === '.') throw new Error('Unknown control key: ' + key);
          if (firstChar === '$') {
            if (hasWildcard) throw new Error('Only one wildcard allowed per object: ' + key);
            locals = locals.concat([key]);
            hasWildcard = true;
          }
          const constraint = value && (_.isString(value) ? value : value['.value']);
          if (constraint) {
            const match = constraint.match(/^\s*((required|indexed|encrypted(\[.*?\])?)(\s+|$))*/);
            if (match) {
              const keywords = match[0].split(/\s+/);
              if (keywords.length > 1 && _.uniq(_.map(keywords, keyword =>
                keyword.replace(/encrypted\[.*?\]/, 'encrypted')
              )).length !== keywords.length) {
                throw new Error('Duplicated child property keywords: ' + key + ' -> ' + match[0]);
              }
              if (_.includes(keywords, 'required')) {
                if (firstChar === '$') throw new Error('Wildcard children cannot be required');
                requiredChildren.push(key);
              }
              if (_.includes(keywords, 'indexed')) {
                if (firstChar === '$') {
                  indexedChildren.push('.value');
                } else {
                  indexedGrandChildren.push(key);
                }
              }
              _.each(keywords, keyword => {
                const match2 = keyword.match(/^encrypted(\[.*?\])?$/);
                if (!match2) return;
                let pattern = match2[1];
                if (pattern) pattern = pattern.slice(1, -1);
                encrypt.value = pattern || '#';
              });
            }
          }
          // Transform *after* extracting all keywords, since processing a .value item will strip it
          // of all keywords in the original yaml tree.
          json[key] = this.transformBranch(value, locals);
          if (!_.isEmpty(encrypt)) json[key]['.encrypt'] = encrypt;
          if (json[key]['.indexChildrenOn']) {
            if (firstChar === '$') {
              indexedChildren.push.apply(indexedChildren, json[key]['.indexChildrenOn']);
            } else {
              indexedGrandChildren = indexedGrandChildren.concat(
                _.map(json[key]['.indexChildrenOn'], indexKey => key + '/' + indexKey)
              );
            }
            delete json[key]['.indexChildrenOn'];
          }
        }
      }
    });
    if (yaml['.read/write']) {
      if (yaml['.read'] || yaml['.write']) {
        throw new Error('Cannot specify both .read/write and .read or .write');
      }
      json['.read'] = json['.write'] = yaml['.read/write'];
    } else {
      if (yaml['.read']) json['.read'] = yaml['.read'];
      if (yaml['.write']) json['.write'] = yaml['.write'];
    }
    let validation = '';
    if (yaml['.value']) validation = yaml['.value'];
    if (requiredChildren.length) {
      if (validation) validation = '(' + validation + ') && ';
      validation +=
        'newData.hasChildren([' +
        _.map(requiredChildren, childName => '\'' + childName + '\'').join(', ') +
        '])';
    }
    if (indexedChildren.length) json['.indexOn'] = indexedChildren;
    if (indexedGrandChildren.length) json['.indexChildrenOn'] = indexedGrandChildren;
    if (validation) json['.validate'] = validation;
    if (!moreAllowed && !hasWildcard) json.$other = {'.validate': false};
    return json;
  }

  expandExpression(expression, locals) {
    if (_.isBoolean(expression)) expression = '' + expression;
    if (!_.isString(expression)) throw new Error('Expression expected, got: ' + expression);
    try {
      // console.log('expand', expression);
      let parsed;
      try {
        parsed = esprima.parse(expression);
      } catch (e) {
        parsed.message += ' in ' + expression;
        throw e;
      }
      const ast = this.transformAst(parsed, locals);
      // console.log(JSON.stringify(ast, null, 2));
      return this.generate(ast);
    } catch (e) {
      e.message += ' in ' + expression;
      throw e;
    }
  }

  transformAst(ast, locals) {
    this.changed = false;
    return estraverse.replace(ast, {
      enter: (node, parent) => {
        if (!node) return;
        if (node.type === 'Identifier' && !(
          parent.type === 'MemberExpression' && !parent.computed && parent.property === node
        )) {
          switch (node.name) {
            case 'auth': case 'now': return;
            case 'root': node.output = 'snapshot'; break;
            case 'next': node.name = 'newData';
            /* fall through */
            case 'newData': node.output = 'snapshot'; break;
            case 'prev': node.name = 'data';
            /* fall through */
            case 'data': node.output = 'snapshot'; break;
            default: {
              const local = _.includes(locals, node.name);
              if (!(local || node.name in this.functions || node.name === 'oneOf' ||
                    node.name === 'env')) {
                throw new Error('Unknown reference: ' + node.name);
              }
              if (!local && !(parent.type === 'MemberExpression' && !parent.computed ||
                    parent.type === 'CallExpression' && parent.callee === node)) {
                this.changed = true;
                return {type: 'CallExpression', callee: node, arguments: []};
              }
            }
          }
        }
        if (node.type === 'CallExpression' && (
          node.callee.type === 'Identifier' && (
            node.callee.name === 'child' || node.callee.name === 'parent') ||
          node.callee.type === 'MemberExpression' && !node.callee.computed && (
            node.callee.property.name === 'child' || node.callee.property.name === 'parent')
        )) {
          node.output = 'snapshot';
        }
      },
      leave: (node, parent) => {
        if (!node) return;
        const originalNode = node;
        if (node.type === 'MemberExpression' && node.object.type === 'Identifier' &&
            node.object.name === 'env') {
          let envValue;
          if (node.computed) {
            if (node.property.type === 'Literal') {
              envValue = process.env[node.property.value];
            } else {
              throw new Error('Unable to expand env variable with computed name: ' + node.property);
            }
          } else {
            envValue = process.env[node.property.name];
          }
          envValue = envValue || '';
          node = {type: 'Literal', value: envValue, raw: envValue};
        }
        if (node.type === 'MemberExpression' && node.object.output === 'snapshot' && !(
          parent.type === 'CallExpression' && parent.callee === node
        )) {
          this.changed = true;
          node = {
            type: 'CallExpression', output: 'snapshot', callee: {
              type: 'MemberExpression', object: node.object, computed: false, property: {
                type: 'Identifier', name: 'child'
              }
            }, arguments: [node.computed ?
              node.property : {type: 'Literal', value: node.property.name, raw: node.property.name}
            ]
          };
        }
        if (node.output === 'snapshot' &&
            (parent.type !== 'MemberExpression' ||
             parent.computed && parent.property === originalNode)) {
          this.changed = true;
          node = {
            type: 'CallExpression', callee: {
              type: 'MemberExpression', object: node, computed: false, property: {
                type: 'Identifier', name: 'val'
              }
            }, arguments: []
          };
        }
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
          if (_.includes(locals, node.callee.name)) return;
          this.changed = true;
          if (node.callee.name === 'oneOf') {
            let condition = {
              type: 'BinaryExpression', operator: '==', left: NEW_DATA_VAL, right: node.arguments[0]
            };
            _.each(node.arguments.slice(1), arg => {
              condition = {type: 'LogicalExpression', operator: '||', left: condition, right: {
                type: 'BinaryExpression', operator: '==', left: NEW_DATA_VAL, right: arg
              }};
            });
            node = condition;
          } else {
            const fn = this.functions[node.callee.name];
            if (!fn) throw new Error('Call to undefined function: ' + this.generate(node));
            if (node.arguments.length !== fn.args.length) {
              throw new Error(
                'Number of arguments in call differs from signature: ' +
                `${this.generate(node)} vs ${node.callee.name}(${fn.args.join(', ')})`);
            }
            const bindings = {};
            _.each(_.zip(fn.args, node.arguments), pair => {
              bindings[pair[0]] = pair[1];
            });
            node = estraverse.replace(clone(fn.ast, false), {
              enter: (node2, parent2) => {
                if (!node2) return;
                if (node2.type === 'Identifier' && node2.name in bindings && !(
                  parent2.type === 'MemberExpression' && !parent2.computed &&
                  parent2.property === node2
                )) {
                  return bindings[node2.name];
                }
              }
            });
          }
        }
        return node;
      }
    });
  }

  generate(ast) {
    return escodegen.generate(ast, {format: {semicolons: false, newline: ' '}});
  }

  extractEncryptDirectives(tree) {
    if (!_.isObject(tree)) return;
    const encryptTree = {};
    _.each(tree, (value, key) => {
      if (key !== '.encrypt') value = this.extractEncryptDirectives(tree[key]);
      if (value) encryptTree[key] = value;
    });
    delete tree['.encrypt'];
    if (!_.isEmpty(encryptTree)) return encryptTree;
  }
}


exports.transform = function(source) {
  return new Compiler(source).transform();
};
