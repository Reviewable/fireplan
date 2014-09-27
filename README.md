firesafe
========

Compiler for an alternative YAML-based syntax for Firebase security rules.  The new syntax is much
more readable but retains the overall semantics of the traditional JSON format, so there's no
surprises.

## Getting Started

First, install the compiler:

```
npm install -g firesafe
```

Then create a `rules.yaml` file like this:

```yaml
functions:
  - percentage: number && next >= 0 && next <= 100
  - canUpdate(subject): root.users[auth.uid].permissions[subject].write

root:
  /data:
    $subject:
      .read: true
      .write: canUpdate($subject)
      value: percentage
      /description: string
  /users:
    $uid:
      .read/write: auth.uid == $uid
      /permissions:
        $subject:
          write: boolean
```

Then compile it into `rules.json` like so:

```
firesafe rules.yaml
```

## Syntax

Firesafe security rules are written in YAML, which gets translated to JSON by the compiler.  Indentation indicates the hierarchical structure and there's no need for quotes, but otherwise it's
pretty similar to the traditional syntax.

One simple up-front difference: the root of the rule hierarchy is `root:` rather than `"rules":`, to better match the predefined `root` variable in security expressions.

### Simple Expressions

Security expressions are used in `.read`, `.write` and `.value` rules, as well as in function definitions (explained below).  All traditional security expression are valid in Firesafe as well, but there's a few extra features you can take advantage of:
- You can use _next_ and _prev_ instead of _newData_ and _data_ (but those still work as well).
- You can use JavaScript-like syntax for accessing children, so that `data.child('foo').child($bar)` becomes `data.foo[$bar]`.
- You can leave off the `.val()` calls altogether, as they'll be inferred automatically (unless you're calling a `String` method like `length` or `contains()`, then you must keep the `.val()`).

Putting all these together, an expression like:
```newData.child('counter').val() == data.child('counter').val() + 1```
becomes:
```next.counter == prev.counter + 1```

### Rule Kinds

The three basic kinds of rules are `.read`, `.write` and `.value`, corresponding directly to the original `.read`, `.write` and `.validate`.  There's also a couple bits of syntactic sugar:
- You can specify a single `.read/write` rule if the `.read` and `.write` expressions are the same.  This is particularly useful for properties that will be updated transactionally, since `transaction()` requires both read and write access to its data.
- If a property only has a validation rule, you can specify it directly as its value.  So `foo: auth.uid == 'admin'` is the same as `foo: {.value: auth.uid == 'admin'}` or
```yaml
foo:
  .value: auth.uid == 'admin'
```

### Children Properties

A very common validation need is to check whether a property has the expected children.  You can do this manually using `hasChildren()` and `$other: false` catchalls, but Firesafe has a special syntax that makes it much easier.  By default, any child listed under a property is *required*, and writing the property will fail if any child is missing.  You can make a child optional by preceding its name with a `/`.  (Why a slash?  It's one of the few characters reserved by Firebase for use in key names.)  Normally no children other than the required and optional ones listed are allowed, but if you'd like to accept any others as well (with no further validation) you can add `.more: true` to the property.

Putting it all together looks like this:
```yaml
root:
  /foo:
    bar: string
    baz:
      /qux: number
      .more: true
```
This means that `/foo` is optional, but if written it must have children `bar` (a string) and `baz`, and no others.   In turn, `baz` can have any children at all, but if `qux` is specified then it must be a number.

### Functions

As security rules grow more complex, you may find yourself repeatedly writing out the same expression snippet in various contexts.  To cut down on duplication, Firesafe allows you to define functions that can then be "called" from expressions (including other functions).  The definitions go into a top-level `functions:` block like this:
```yaml
functions:
  - foo(bar, baz): next.qux == bar || auth.uid == baz
  - foo2: foo('arrr', 'matey')
```
A function can take any number of arguments; if it doesn't take any, you can leave out the empty parentheses.  Function names must be unique (there's no dispatch on the number of arguments).  A function's body is an expression just like that of any security rule, and can access the function's arguments as well as the usual security rules globals (`auth`, `next`, etc.).

Functions are called in the usual way, like `foo('bar', next.baz)`.  A function can call other functions in its body but recursion is forbidden (and will crash the compiler).  If a function doesn't take arguments you can also call it without parentheses, like `foo2`.  This is especially convenient for defining new "value types", like `percentage` in the example at the top.  Firesafe predefines the three value types `string`, `boolean` and `number` like so:
```yaml
functions:
  - string: next.isString()
  - boolean: next.isBoolean()
  - number: next.isNumber()
```

## That's All!

Please let me know if you have any problems.
