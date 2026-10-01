import { createElement, useEffect, useState } from 'react'
import { PassThrough } from 'node:stream'
import headless from '@xterm/headless'
import { render, type Instance } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createInkOutputs } from '../src/tui/terminal/terminal.js'
import { PromptEditor } from '../src/tui/view/prompt-editor.js'
import { Box, Text } from '../src/tui/view/theme.js'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

const instances: Instance[] = []

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    instance.unmount()
    await instance.waitUntilExit()
  }
})

// Commits frames on an interval without re-rendering the editor, like animation
// ticks elsewhere in the tree.
function Heartbeat({ onTick }: { onTick(): void }): null {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      onTick()
      tick((value) => value + 1)
    }, 10)
    return (): void => clearInterval(timer)
  }, [onTick])
  return null
}

interface Mounted {
  output: NodeJS.WriteStream
  screen: headless.Terminal
}

function mountEditor(
  props: { input: string; cursor: number },
  onTick?: (() => void) | undefined,
  wrap = false
): Mounted {
  const output = ttyOutput(20, 20)
  const screen = new headless.Terminal({ cols: 20, rows: 20, allowProposedApi: true })
  output.on('data', (chunk: Buffer) => screen.write(chunk))
  const streams = wrap ? createInkOutputs(output, output, true) : { stdout: output, stderr: output }
  const children = [
    ...(onTick ? [createElement(Heartbeat, { onTick })] : []),
    createElement(Text, undefined, 'above'),
    createElement(PromptEditor, { animateCursor: false, width: 20, ...props }),
  ]
  const instance = render(createElement(Box, { flexDirection: 'column' }, ...children), {
    stdin: ttyInput(),
    stdout: streams.stdout,
    stderr: streams.stderr,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
    incrementalRendering: true,
  })
  instances.push(instance)
  return { output, screen }
}

function editorApp(busyStatus: string | undefined) {
  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(Text, undefined, 'above'),
    createElement(PromptEditor, {
      animateCursor: false,
      width: 20,
      input: '안녕',
      cursor: 2,
      ...(busyStatus === undefined ? {} : { busyStatus }),
    })
  )
}

describe('IME composition cursor', () => {
  it('positions the terminal cursor inside the input box at the editing position', async () => {
    const { screen } = mountEditor({ input: '안녕', cursor: 2 })
    try {
      // One column of surface padding plus the display width of the committed text.
      await vi.waitFor(() => {
        expect(screen.buffer.active.cursorX).toBe(5)
        expect(screen.buffer.active.cursorY).toBe(1)
      })
      const line = screen.buffer.active.getLine(1)!.translateToString(true)
      expect(line).toContain('안녕')
      expect(line).not.toContain('▌')
    } finally {
      screen.dispose()
    }
  })

  it('positions the terminal cursor at the start of the empty prompt', async () => {
    const { screen } = mountEditor({ input: '', cursor: 0 })
    try {
      await vi.waitFor(() => {
        expect(screen.buffer.active.cursorX).toBe(1)
        expect(screen.buffer.active.cursorY).toBe(1)
      })
      expect(screen.buffer.active.getLine(1)!.translateToString(true)).not.toContain('▌')
    } finally {
      screen.dispose()
    }
  })

  it('holds the cursor in the input box through the production stdout wrapper', async () => {
    const { screen } = mountEditor({ input: '안녕', cursor: 2 }, undefined, true)
    try {
      await vi.waitFor(() => {
        expect(screen.buffer.active.cursorX).toBe(5)
        expect(screen.buffer.active.cursorY).toBe(1)
      })
      expect(screen.buffer.active.getLine(1)!.translateToString(true)).toContain('안녕')
    } finally {
      screen.dispose()
    }
  })

  it('keeps the cursor in place across renders that do not touch the editor', async () => {
    let ticks = 0
    const onTick = (): void => {
      ticks += 1
    }
    const { output, screen } = mountEditor({ input: '안녕', cursor: 2 }, onTick)
    try {
      await vi.waitFor(() => {
        expect(screen.buffer.active.cursorX).toBe(5)
        expect(screen.buffer.active.cursorY).toBe(1)
      })
      let bytes = 0
      output.on('data', (chunk: Buffer) => {
        bytes += chunk.length
      })
      // Wait for a window of unrelated commits, then require that none of them wrote.
      await vi.waitFor(() => {
        expect(ticks).toBeGreaterThanOrEqual(8)
      })
      expect(bytes).toBe(0)
      expect(screen.buffer.active.cursorX).toBe(5)
      expect(screen.buffer.active.cursorY).toBe(1)
    } finally {
      screen.dispose()
    }
  })

  it('parks the wrapped terminal cursor where it was last shown', async () => {
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 20,
      rows: 5,
    }) as unknown as NodeJS.WriteStream
    const screen = new headless.Terminal({ cols: 20, rows: 5, allowProposedApi: true })
    output.on('data', (chunk: Buffer) => screen.write(chunk))
    const flush = (): Promise<void> =>
      // Promise.withResolvers is unavailable under the repository's TypeScript lib target.
      new Promise<void>((resolve) => {
        screen.write('', () => resolve())
      })
    try {
      const { stdout } = createInkOutputs(output, output, true)
      stdout.write('\x1b[4;6H\x1b[?25h')
      await flush()
      expect(screen.buffer.active.cursorX).toBe(5)
      expect(screen.buffer.active.cursorY).toBe(3)
      stdout.write('x')
      await flush()
      // The resume marker restores the saved cell, so the write lands there.
      expect(screen.buffer.active.getLine(3)!.translateToString(true)).toBe('     x')
    } finally {
      screen.dispose()
      output.destroy()
    }
  })

  it('hides the terminal cursor when the editor shows status instead of text', async () => {
    const output = ttyOutput(20, 20)
    const screen = new headless.Terminal({ cols: 20, rows: 20, allowProposedApi: true })
    output.on('data', (chunk: Buffer) => screen.write(chunk))
    const writes: string[] = []
    output.on('data', (chunk: Buffer) => {
      writes.push(chunk.toString())
    })
    try {
      const instance = render(editorApp(undefined), {
        stdin: ttyInput(),
        stdout: output,
        stderr: output,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
        incrementalRendering: true,
      })
      instances.push(instance)
      await vi.waitFor(() => {
        expect(screen.buffer.active.cursorX).toBe(5)
        expect(screen.buffer.active.cursorY).toBe(1)
      })
      instance.rerender(editorApp('working'))
      await vi.waitFor(() => {
        expect(screen.buffer.active.getLine(1)!.translateToString(true)).toContain('working')
      })
      await vi.waitFor(() => {
        expect(writes.join('')).toContain('\x1b[?25l')
      })
    } finally {
      screen.dispose()
    }
  })
})
