import { AskResponse, Citation } from '../../api'

export type ParsedAnswer = {
  parsedcitation: Citation[]
  citations: Citation[]
  markdownFormatText: string
}

export const enumerateCitations = (citations: Citation[]) => {
  const filepathMap = new Map()
  for (const citation of citations) {
    const { filepath } = citation
    let part_i = 1
    if (filepathMap.has(filepath)) {
      part_i = filepathMap.get(filepath) + 1
    }
    filepathMap.set(filepath, part_i)
    citation.part_index = part_i
  }
  return citations
}

export function parseAnswer(answer: AskResponse): ParsedAnswer {
  return {
    parsedcitation: [],
    citations: answer.citations || [],
    markdownFormatText: answer.answer,
  }
}
