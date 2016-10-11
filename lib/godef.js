'use babel'

import {CompositeDisposable, Point} from 'atom'
import {NavigationStack} from './navigation-stack'
import path from 'path'
import fs from 'fs'

class Godef {
  constructor (goconfigFunc, gogetFunc) {
    this.goget = gogetFunc
    this.goconfig = goconfigFunc
    this.subscriptions = new CompositeDisposable()
    this.godefCommand = 'golang:godef'
    this.returnCommand = 'golang:godef-return'
    this.navigationStack = new NavigationStack()
    atom.commands.add('atom-workspace', 'golang:godef', () => {
      if (this.ready()) {
        this.gotoDefinitionForWordAtCursor()
      }
    })
    atom.commands.add('atom-workspace', 'golang:godef-return', () => {
      if (this.navigationStack) {
        this.navigationStack.restorePreviousLocation()
      }
    })
    this.cursorOnChangeSubscription = null
  }

  dispose () {
    if (this.subscriptions) {
      this.subscriptions.dispose()
    }
    this.subscriptions = null
    this.goget = null
    this.goconfig = null
    this.toolCheckComplete = null
  }

  ready () {
    if (!this.goconfig || !this.goconfig()) {
      return false
    }

    return true
  }

  clearReturnHistory () {
    this.navigationStack.reset()
  }

  getEditor () {
    if (!atom || !atom.workspace) {
      return
    }
    let editor = atom.workspace.getActiveTextEditor()
    if (!this.isValidEditor(editor)) {
      return
    }

    return editor
  }

  isValidEditor (editor) {
    if (!editor || !editor.getGrammar()) {
      return false
    }

    return editor.getGrammar().scopeName === 'source.go'
  }

  gotoDefinitionForWordAtCursor () {
    let editor = this.getEditor()
    if (!editor) {
      return Promise.resolve(false)
    }

    if (editor.hasMultipleCursors()) {
      atom.notifications.addWarning('navigator-go', {
        dismissable: true,
        icon: 'location',
        detail: 'godef only works with a single cursor'
      })
      return Promise.resolve(false)
    }

    return Promise.resolve().then(() => {
      let editorCursorUTF8Offset = (e) => {
        let characterOffset = e.getBuffer().characterIndexForPosition(e.getCursorBufferPosition())
        let text = e.getText().substring(0, characterOffset)
        return Buffer.byteLength(text, 'utf8')
      }

      let offset = editorCursorUTF8Offset(editor)
      if (this.cursorOnChangeSubscription) {
        this.cursorOnChangeSubscription.dispose()
        this.cursorOnChangeSubscription = null
      }
      return this.gotoDefinitionWithParameters(offset)
    })
  }

  gotoDefinitionWithParameters (offset) {
    let editor = this.getEditor()
    let config = this.goconfig()
    return this.checkForTool(editor).then((cmd) => {
      if (!cmd) {
        return
      }

      let filepath = editor.getPath()
      let args = ['-json', 'definition', filepath+":#"+offset]
      let options = this.getExecutorOptions(editor)
      return config.executor.exec(cmd, args, options).then((r) => {
        if (r.stderr && r.stderr.trim() !== '') {
          console.log('navigator-go: (stderr) ' + r.stderr)
        }
        if (r.exitcode !== 0) {
          // TODO: Notification?
          return false
        }
        return this.visitLocation(this.parseGuruDefinition(r.stdout))
      }).catch((e) => {
        console.log(e)
        return false
      })
    })
  }

  getLocatorOptions (editor = this.getEditor()) {
    let options = {}
    if (editor) {
      options.file = editor.getPath()
      options.directory = path.dirname(editor.getPath())
    }
    if (!options.directory && atom.project.paths.length) {
      options.directory = atom.project.paths[0]
    }

    return options
  }

  getExecutorOptions (editor = this.getEditor()) {
    let o = this.getLocatorOptions(editor)
    let options = {}
    if (o.directory) {
      options.cwd = o.directory
    }
    let config = this.goconfig()
    if (config) {
      options.env = config.environment(o)
    }
    if (!options.env) {
      options.env = process.env
    }
    return options
  }

  checkForTool (editor = this.getEditor()) {
    let config = this.goconfig()
    let options = this.getLocatorOptions(editor)
    return config.locator.findTool('guru', options).then((cmd) => {
      if (cmd) {
        return cmd
      }

      if (!cmd && !this.toolCheckComplete) {
        this.toolCheckComplete = true
        let goget = this.goget()
        if (!goget) {
          return false
        }
        goget.get({
          name: 'navigator-go',
          packageName: 'guru',
          packagePath: 'golang.org/x/tools/cmd/guru',
          type: 'missing'
        }).then((r) => {
          if (!r.success) {
            return false
          }
          return this.updateTools(editor)
        }).catch((e) => {
          console.log(e)
        })
      }

      return false
    })
  }

  parseGuruDefinition (guruStdout) {
    let result = {
      raw: guruStdout
    }
    data = JSON.parse(guruStdout)
    if (!data || !data.objpos) {
      return result
    }

    let outputs = data.objpos.trim().split(':')
    let colNumber = 0
    let rowNumber = 0
    if (outputs.length > 1) {
      colNumber = outputs.pop()
      rowNumber = outputs.pop()
    }
    result.filepath = outputs.pop()

    // atom's cursors are 0-based; guru uses diff-like 1-based
    let p = (rawPosition) => {
      return parseInt(rawPosition, 10) - 1
    }

    if (rowNumber && colNumber) {
      result.pos = new Point(p(rowNumber), p(colNumber))
    }
    return result
  }

  visitLocation (loc, callback) {
    if (!loc || !loc.filepath) {
      if (loc) {
        atom.notifications.addWarning('navigator-go', {
          dismissable: true,
          icon: 'location',
          description: JSON.stringify(loc.raw),
          detail: 'guru returned malformed output'
        })
      } else {
        atom.notifications.addWarning('navigator-go', {
          dismissable: true,
          icon: 'location',
          detail: 'guru returned malformed output'
        })
      }

      return false
    }

    return fs.stat(loc.filepath, (err, stats) => {
      if (err) {
        if (err.handle) {
          err.handle()
        }
        atom.notifications.addWarning('navigator-go', {
          dismissable: true,
          icon: 'location',
          detail: 'guru returned invalid file path',
          description: loc.filepath
        })
        return false
      }

      this.navigationStack.pushCurrentLocation()
      if (stats.isDirectory()) {
        return this.visitDirectory(loc, callback)
      } else {
        return this.visitFile(loc, callback)
      }
    })
  }

  visitFile (loc, callback) {
    return atom.workspace.open(loc.filepath).then((editor) => {
      if (loc.pos) {
        editor.scrollToBufferPosition(loc.pos)
        editor.setCursorBufferPosition(loc.pos)
        this.cursorOnChangeSubscription = this.highlightWordAtCursor(editor)
      }
    })
  }

  visitDirectory (loc, callback) {
    return this.findFirstGoFile(loc.filepath).then((file) => {
      return this.visitFile({filepath: file, raw: loc.raw}, callback)
    }).catch((err) => {
      if (err.handle) {
        err.handle()
      }
      atom.notifications.addWarning('navigator-go', {
        dismissable: true,
        icon: 'location',
        detail: 'guru return invalid directory',
        description: loc.filepath
      })
    })
  }

  findFirstGoFile (dir) {
    return new Promise((resolve, reject) => {
      fs.readdir(dir, (err, files) => {
        if (err) {
          reject(err)
        }

        let filepath = this.firstGoFilePath(dir, files.sort())
        if (filepath) {
          resolve(filepath)
        } else {
          reject(dir + 'has no non-test .go file')
        }
      })
    })
  }

  firstGoFilePath (dir, files) {
    for (let file of files) {
      if (file.endsWith('.go') && (file.indexOf('_test') === -1)) {
        return path.join(dir, file)
      }
    }

    return
  }

  wordAtCursor (editor = this.editor) {
    let options = {
      wordRegex: /[\w+\.]*/
    }

    let cursor = editor.getLastCursor()
    let range = cursor.getCurrentWordBufferRange(options)
    let word = editor.getTextInBufferRange(range)
    return {word: word, range: range}
  }

  highlightWordAtCursor (editor = this.editor) {
    let {range} = this.wordAtCursor(editor)
    let marker = editor.markBufferRange(range, {invalidate: 'inside'})
    editor.decorateMarker(marker, {type: 'highlight', class: 'definition'})
    let cursor = editor.getLastCursor()
    cursor.onDidChangePosition(() => {
      marker.destroy()
    })
  }
}

export {Godef}
