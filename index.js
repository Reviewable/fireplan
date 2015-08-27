'use strict';

var _ = require('underscore');
var esprima = require('esprima');
var escodegen = require('escodegen');
var estraverse = require('estraverse');
var clone = require('clone');

var BUILTINS = {
  auth: true, now: true, root: true, next: true, newData: true, prev: true, data: true
};

exports.transform = function(source) {
  return new Compiler(source).transform();
};

function Compiler(source) {
  this.source = source;
}

Compiler.prototype.transform = function() {
  this.defineFunctions();
  var tree = this.transformBranch(this.source.root, []);
  if (tree['.indexChildrenOn']) {
    throw new Error('Indexed attributes must be at least two levels deep in the tree.');
  }
  return {rules: tree};
};

Compiler.prototype.defineFunctions = function() {
  this.source.functions = this.source.functions || [];
  this.source.functions.push(
    {'boolean': 'next.isBoolean()'},
    {'string': 'next.isString()'},
    {'number': 'next.isNumber()'},
    {'any': 'true'}
  );
  this.functions = {};
  _.each(this.source.functions, function(definition) {
    _.each(definition, function(body, signature) {
      var match = signature.match(/^\s*(\w+)\s*(?:\((.*?)\))?\s*$/);
      if (!match) throw new Error('Invalid function signature: ' + signature);
      var name = match[1];
      var args = _.compact(_.map((match[2] || '').split(','), function(arg) {return arg.trim();}));
      _.each(args, function(arg) {
        if (arg in BUILTINS) {
          throw new Error('Argument name "' + arg + '" shadows builtin variable');
        }
      });
      if (name in this.functions) throw new Error('Duplicate function definition: ' + name);
      this.functions[name] = {name: name, args: args, ast: esprima.parse(body).body[0].expression};
    }, this);
  }, this);
  var changed = true;
  while (changed) {
    /*jshint -W083 */
    changed = false;
    _.each(this.functions, function(fn, name) {
      fn.ast = this.transformAst(fn.ast, fn.args);
      changed = changed || this.changed;
    }, this);
    /*jshint +W083 */
  }
};

Compiler.prototype.transformBranch = function(yaml, locals) {
  var json = {};
  if (_.isString(yaml)) yaml = {'.value': yaml};
  var requiredChildren = [], indexedChildren = [], indexedGrandChildren = [];
  var moreAllowed = false, hasWildcard = false;
  _.each(yaml, function(value, key) {
    switch(key) {
      case '.value':
        value = value.replace(/^\s*((required|indexed)(\s+|$))*/, '');
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
      default:
        var firstChar = key.charAt(0);
        if (firstChar === '.') throw new Error('Unknown control key: ' + key);
        if (firstChar === '$') {
          if (hasWildcard) throw new Error('Only one wildcard allowed per object: ' + key);
          locals = locals.concat([key]);
          hasWildcard = true;
        }
        var constraint = value && (_.isString(value) ? value : value['.value']);
        if (constraint) {
          var match = constraint.match(/^\s*((required|indexed)(\s+|$))*/);
          if (match) {
            var keywords = match[0].split(/\s+/);
            if (keywords.length > 1 && _.uniq(keywords).length !== keywords.length) {
              throw new Error('Duplicated child property keywords: ' + key + ' -> ' + match[0]);
            }
            if (_.contains(keywords, 'required')) {
              if (firstChar === '$') throw new Error('Wildcard children cannot be required');
              requiredChildren.push(key);
            }
            if (_.contains(keywords, 'indexed')) {
              if (firstChar === '$') {
                indexedChildren.push('.value');
              } else {
                indexedGrandChildren.push(key);
              }
            }
          }
        }
        json[key] = this.transformBranch(value, locals);
        if (json[key]['.indexChildrenOn']) {
          indexedChildren.push.apply(indexedChildren, json[key]['.indexChildrenOn']);
          delete json[key]['.indexChildrenOn'];
        }
    }
  }, this);
  if (yaml['.read/write']) {
    if (yaml['.read'] || yaml['.write']) throw new Error(
      'Cannot specify both .read/write and .read or .write');
    json['.read'] = json['.write'] = yaml['.read/write'];
  } else {
    if (yaml['.read']) json['.read'] = yaml['.read'];
    if (yaml['.write']) json['.write'] = yaml['.write'];
  }
  var validation = '';
  if (yaml['.value']) validation = yaml['.value'];
  if (requiredChildren.length) {
    if (validation) validation = '(' + validation + ') && ';
    validation +=
      'newData.hasChildren([' +
      _.map(requiredChildren, function(childName) {return '\'' + childName + '\'';}).join(', ') +
      '])';
  }
  if (indexedChildren.length) json['.indexOn'] = indexedChildren;
  if (indexedGrandChildren.length) json['.indexChildrenOn'] = indexedGrandChildren;
  if (validation) json['.validate'] = validation;
  if (!moreAllowed && !hasWildcard) json.$other = {'.validate': false};
  return json;
};

Compiler.prototype.expandExpression = function(expression, locals) {
  if (_.isBoolean(expression)) expression = '' + expression;
  if (!_.isString(expression)) throw new Error('Expression expected, got: ' + expression);
  // console.log('expand', expression);
  var ast = this.transformAst(esprima.parse(expression), locals);
  // console.log(JSON.stringify(ast, null, 2));
  return this.generate(ast);
};

var NEW_DATA_VAL = {type: 'CallExpression', arguments: [], callee: {
  type: 'MemberExpression', computed: false, object: {type: 'Identifier', name: 'newData'},
  property: {type: 'Identifier', name: 'val'}
}};

Compiler.prototype.transformAst = function(ast, locals) {
  this.changed = false;
  var self = this;
  return estraverse.replace(ast, {
    enter: function(node, parent) {
      if (!node) return;
      if (node.type === 'Identifier' && !(
          parent.type === 'MemberExpression' && !parent.computed && parent.property === node)) {
        switch (node.name) {
          case 'auth': case 'now': return;
          case 'root': node.output = 'snapshot'; break;
          case 'next': node.name = 'newData';
          /* fall through */
          case 'newData': node.output = 'snapshot'; break;
          case 'prev': node.name = 'data';
          /* fall through */
          case 'data': node.output = 'snapshot'; break;
          default:
            var local = _.contains(locals, node.name);
            if (!(local || node.name in self.functions || node.name === 'oneOf')) {
              throw new Error('Unknown reference: ' + node.name);
            }
            if (!local && !(parent.type === 'MemberExpression' ||
                  parent.type === 'CallExpression' && parent.callee === node)) {
              this.changed = true;
              return {type: 'CallExpression', callee: node, arguments: []};
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
    leave: function(node, parent) {
      if (!node) return;
      var originalNode = node;
      if (node.type === 'MemberExpression' && node.object.output === 'snapshot' && !(
            parent.type === 'CallExpression' && parent.callee === node)) {
        self.changed = true;
        node = {
          type: 'CallExpression', output: 'snapshot', callee: {
            type: 'MemberExpression', object: node.object, computed: false, property: {
              type: 'Identifier', name: 'child'
            }
          }, arguments: [node.computed ?
            node.property :  {type: 'Literal', value: node.property.name, raw: node.property.name}
          ]
        };
      }
      if (node.output === 'snapshot' &&
          (parent.type !== 'MemberExpression' ||
           parent.computed && parent.property === originalNode)) {
        self.changed = true;
        node = {
          type: 'CallExpression', callee: {
            type: 'MemberExpression', object: node, computed: false, property: {
              type: 'Identifier', name: 'val'
            }
          }, arguments: []
        };
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        if (_.contains(locals, node.callee.name)) return;
        self.changed = true;
        if (node.callee.name === 'oneOf') {
          var condition = {
            type: 'BinaryExpression', operator: '==', left: NEW_DATA_VAL, right: node.arguments[0]
          };
          _.each(node.arguments.slice(1), function(arg) {
            condition = {type: 'LogicalExpression', operator: '||', left: condition, right: {
              type: 'BinaryExpression', operator: '==', left: NEW_DATA_VAL, right: arg
            }};
          });
          node = condition;
        } else {
          var fn = self.functions[node.callee.name];
          if (!fn) throw new Error('Call to undefined function: ' + self.generate(node));
          if (node.arguments.length !== fn.args.length) {
            throw new Error('Number of arguments in call differs from signature: ' +
              self.generate(node) + ' vs ' + node.callee.name + '(' + fn.args.join(', ') + ')');
          }
          var bindings = {};
          _.each(_.zip(fn.args, node.arguments), function(pair) {
            bindings[pair[0]] = pair[1];
          });
          node = estraverse.replace(clone(fn.ast, false), {
            enter: function(node, parent) {
              if (!node) return;
              if (node.type === 'Identifier' && node.name in bindings && !(
                  parent.type === 'MemberExpression' && !parent.computed &&
                  parent.property === node)) {
                return bindings[node.name];
              }
            }
          });
        }
      }
      return node;
    }
  });
};

Compiler.prototype.generate = function(ast) {
  return escodegen.generate(ast, {format: {semicolons: false, newline: ' '}});
};
