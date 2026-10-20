import { createContext, useContext } from 'react'

/** True for pages rendered inside AppLayout's padded <main> (false: fullscreen / public pages). */
export const InShellContext = createContext(false)

export const useInShell = (): boolean => useContext(InShellContext)
