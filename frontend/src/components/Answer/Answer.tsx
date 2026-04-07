import { FormEvent, useContext, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Checkbox, DefaultButton, Dialog, FontIcon, Stack, Text, IconButton } from '@fluentui/react'
import { useBoolean } from '@fluentui/react-hooks'
import { ThumbDislike20Filled, ThumbLike20Filled } from '@fluentui/react-icons'
import DOMPurify from 'dompurify'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { AskResponse, Citation, Feedback, historyMessageFeedback } from '../../api'
import { AppStateContext } from '../../state/AppProvider'
import { parseAnswer } from './AnswerParser'

import styles from './Answer.module.css'

interface Props {
  answer: AskResponse
  onCitationClicked: (citedDocument: Citation) => void
}

export const Answer = ({ answer, onCitationClicked }: Props) => {
  const initializeAnswerFeedback = (answer: AskResponse) => {
    if (answer.message_id == undefined) return undefined
    if (answer.feedback == undefined) return undefined
    if (answer.feedback.split(',').length > 1) return Feedback.Negative
    if (Object.values(Feedback).includes(answer.feedback)) return answer.feedback
    return Feedback.Neutral
  }

  const [isRefAccordionOpen, { toggle: toggleIsRefAccordionOpen }] = useBoolean(false)
  const [isToolCallsOpen, setIsToolCallsOpen] = useState(false)
  const [isDocsOpen, setIsDocsOpen] = useState(false)
  const [expandedDocIndices, setExpandedDocIndices] = useState<Set<number>>(new Set())
  const filePathTruncationLimit = 50

  const parsedAnswer = useMemo(() => parseAnswer(answer), [answer])
  const [chevronIsExpanded, setChevronIsExpanded] = useState(isRefAccordionOpen)
  const [feedbackState, setFeedbackState] = useState(initializeAnswerFeedback(answer))
  const [isFeedbackDialogOpen, setIsFeedbackDialogOpen] = useState(false)
  const [showReportInappropriateFeedback, setShowReportInappropriateFeedback] = useState(false)
  const [negativeFeedbackList, setNegativeFeedbackList] = useState<Feedback[]>([])
  const appStateContext = useContext(AppStateContext)
  const isSubCitationPanelOpen = appStateContext?.state?.isSubCitationPanelOpen

  const FEEDBACK_ENABLED =
    appStateContext?.state.frontendSettings?.feedback_enabled && appStateContext?.state.isHistoryAvailable?.foundry

  const [activeCitation, setActiveCitation] = useState<Citation>()
  const [activeCitationTimestamp, setActiveCitationTimestamp] = useState<string | undefined>()

  const handleChevronClick = () => {
    setChevronIsExpanded(!chevronIsExpanded)
    toggleIsRefAccordionOpen()
  }

  const onShowCitation = (citation: Citation, timestamp?: string) => {
    setActiveCitation(citation)
    setActiveCitationTimestamp(timestamp)
    if (appStateContext) {
      appStateContext.dispatch({ type: 'OPEN_CHAT_CITATION_PANEL', payload: false })
      appStateContext.dispatch({ type: 'OPEN_ANSWER_CITATION_PANEL', payload: true })
    }
  }

  const getHighlightedContent = () => {
    if (!activeCitation) return ''
    if (!activeCitationTimestamp) return activeCitation.content
    const escapedTimestamp = activeCitationTimestamp.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&')
    let formattedContent = activeCitation.content
    formattedContent = formattedContent.replace(
      new RegExp(escapedTimestamp, 'g'),
      `<span id="highlighted-timestamp" style="background-color: yellow; font-weight: bold;">${activeCitationTimestamp}</span>`
    )
    formattedContent = formattedContent.replace(
      /\[\d{2}:\d{2}:\d{2}\]/g,
      match => `<br/><br/><strong>${match}</strong>`
    )
    return formattedContent
  }

  useEffect(() => {
    if (isSubCitationPanelOpen && activeCitationTimestamp) {
      const el = document.getElementById('highlighted-timestamp')
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [isSubCitationPanelOpen, activeCitationTimestamp])

  useEffect(() => {
    setChevronIsExpanded(isRefAccordionOpen)
  }, [isRefAccordionOpen])

  useEffect(() => {
    if (answer.message_id == undefined) return
    let currentFeedbackState
    if (appStateContext?.state.feedbackState && appStateContext?.state.feedbackState[answer.message_id]) {
      currentFeedbackState = appStateContext?.state.feedbackState[answer.message_id]
    } else {
      currentFeedbackState = initializeAnswerFeedback(answer)
    }
    setFeedbackState(currentFeedbackState)
  }, [appStateContext?.state.feedbackState, feedbackState, answer.message_id])

  const createCitationFilepath = (citation: Citation, index: number, truncate: boolean = false) => {
    let citationFilename = ''
    if (citation.title) {
      if (truncate && citation.title.length > filePathTruncationLimit) {
        const citationLength = citation.title.length
        citationFilename = `${citation.title.substring(0, 20)}...${citation.title.substring(citationLength - 20)} `
      } else {
        citationFilename = `${citation.title}`
      }
    } else if (citation.reindex_id) {
      citationFilename = `Citation ${citation.reindex_id}`
    } else {
      citationFilename = `Citation ${index}`
    }

    // Add doc_type badge
    if (citation.doc_type) {
      const typeLabel = citation.doc_type === 'chunk' ? '📝' : citation.doc_type === 'voc' ? '🎥' : '📁'
      citationFilename = `${typeLabel} ${citationFilename}`
    }
    return citationFilename
  }

  const onLikeResponseClicked = async () => {
    if (answer.message_id == undefined) return
    let newFeedbackState = feedbackState === Feedback.Positive ? Feedback.Neutral : Feedback.Positive
    appStateContext?.dispatch({
      type: 'SET_FEEDBACK_STATE',
      payload: { answerId: answer.message_id, feedback: newFeedbackState }
    })
    setFeedbackState(newFeedbackState)
    await historyMessageFeedback(answer.message_id, newFeedbackState)
  }

  const onDislikeResponseClicked = async () => {
    if (answer.message_id == undefined) return
    if (feedbackState === undefined || feedbackState === Feedback.Neutral || feedbackState === Feedback.Positive) {
      setFeedbackState(Feedback.Negative)
      setIsFeedbackDialogOpen(true)
    } else {
      setFeedbackState(Feedback.Neutral)
      await historyMessageFeedback(answer.message_id, Feedback.Neutral)
    }
    appStateContext?.dispatch({
      type: 'SET_FEEDBACK_STATE',
      payload: { answerId: answer.message_id, feedback: (feedbackState ?? Feedback.Neutral) as Feedback.Positive | Feedback.Negative | Feedback.Neutral }
    })
  }

  const updateFeedbackList = (ev?: FormEvent<HTMLElement | HTMLInputElement>, checked?: boolean) => {
    if (answer.message_id == undefined) return
    const selectedFeedback = (ev?.target as HTMLInputElement)?.id as Feedback
    let feedbackList = negativeFeedbackList.slice()
    if (checked) {
      feedbackList.push(selectedFeedback)
    } else {
      feedbackList = feedbackList.filter(f => f !== selectedFeedback)
    }
    setNegativeFeedbackList(feedbackList)
  }

  const onSubmitNegativeFeedback = async () => {
    if (answer.message_id == undefined) return
    await historyMessageFeedback(answer.message_id, negativeFeedbackList.join(','))
    resetFeedbackDialog()
  }

  const resetFeedbackDialog = () => {
    setIsFeedbackDialogOpen(false)
    setShowReportInappropriateFeedback(false)
    setNegativeFeedbackList([])
  }

  const UnhelpfulFeedbackContent = () => (
    <>
      <div>Why wasn't this response helpful?</div>
      <Stack tokens={{ childrenGap: 4 }}>
        <Checkbox label="Citations are missing" id={Feedback.MissingCitation} onChange={updateFeedbackList} />
        <Checkbox label="Citations are wrong" id={Feedback.WrongCitation} onChange={updateFeedbackList} />
        <Checkbox label="The response is not from my data" id={Feedback.OutOfScope} onChange={updateFeedbackList} />
        <Checkbox label="Inaccurate or irrelevant" id={Feedback.InaccurateOrIrrelevant} onChange={updateFeedbackList} />
        <Checkbox label="Other" id={Feedback.OtherUnhelpful} onChange={updateFeedbackList} />
      </Stack>
      <div onClick={() => setShowReportInappropriateFeedback(true)} style={{ color: '#115EA3', cursor: 'pointer' }}>
        Report inappropriate content
      </div>
    </>
  )

  const ReportInappropriateFeedbackContent = () => (
    <>
      <div>The content is <span style={{ color: 'red' }}>*</span></div>
      <Stack tokens={{ childrenGap: 4 }}>
        <Checkbox label="Hate speech" id={Feedback.HateSpeech} onChange={updateFeedbackList} />
        <Checkbox label="Violent" id={Feedback.Violent} onChange={updateFeedbackList} />
        <Checkbox label="Sexual" id={Feedback.Sexual} onChange={updateFeedbackList} />
        <Checkbox label="Manipulative" id={Feedback.Manipulative} onChange={updateFeedbackList} />
        <Checkbox label="Other" id={Feedback.OtherHarmful} onChange={updateFeedbackList} />
      </Stack>
    </>
  )

  return (
    <>
      <Stack className={styles.answerContainer} tabIndex={0}>
        <Stack.Item grow className={styles.answerLeft}>
          {parsedAnswer.markdownFormatText && (
            <ReactMarkdown
              linkTarget="_blank"
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              className={styles.answerText}>
              {parsedAnswer.markdownFormatText}
            </ReactMarkdown>
          )}

          {/* Feedback */}
          {FEEDBACK_ENABLED && answer.message_id !== undefined && (
            <Stack horizontal horizontalAlign="start" tokens={{ childrenGap: 8 }} className={styles.answerHeader}>
              <ThumbLike20Filled
                aria-label="Like this response"
                onClick={() => onLikeResponseClicked()}
                style={feedbackState === Feedback.Positive ? { color: 'darkgreen' } : { color: 'slategray' }}
              />
              <ThumbDislike20Filled
                aria-label="Dislike this response"
                onClick={() => onDislikeResponseClicked()}
                style={feedbackState === Feedback.Negative ? { color: 'darkred' } : { color: 'slategray' }}
              />
            </Stack>
          )}

          {/* Tool Calls Section */}
          {answer.tool_calls && answer.tool_calls.length > 0 && (
            <div className={styles.toolCallsSection}>
              <Stack horizontal verticalAlign="center" className={styles.toolCallsHeader}
                onClick={() => setIsToolCallsOpen(!isToolCallsOpen)}>
                <FontIcon iconName={isToolCallsOpen ? 'ChevronDown' : 'ChevronRight'}
                  className={styles.toolCallsChevron} />
                <Text className={styles.toolCallsTitle}>
                  🔧 Tool Calls ({answer.tool_calls.length})
                </Text>
              </Stack>
              {isToolCallsOpen && (
                <div className={styles.toolCallsTableWrapper}>
                  <table className={styles.toolCallsTable}>
                    <thead>
                      <tr>
                        <th>Iter</th>
                        <th>Tool</th>
                        <th>Arguments</th>
                      </tr>
                    </thead>
                    <tbody>
                      {answer.tool_calls.map((tc, i) => (
                        <tr key={i}>
                          <td className={styles.toolCallIter}>{tc.iteration}</td>
                          <td className={styles.toolCallName}>{tc.tool}</td>
                          <td className={styles.toolCallArgs}>
                            <pre>{JSON.stringify(tc.args, null, 2)}</pre>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Documents Fetched Section */}
          {answer.documents && answer.documents.length > 0 && (
            <div className={styles.docsSection}>
              <Stack horizontal verticalAlign="center" className={styles.docsHeader}
                onClick={() => setIsDocsOpen(!isDocsOpen)}>
                <FontIcon iconName={isDocsOpen ? 'ChevronDown' : 'ChevronRight'}
                  className={styles.toolCallsChevron} />
                <Text className={styles.toolCallsTitle}>
                  📄 Documents Fetched ({answer.documents.length})
                </Text>
              </Stack>
              {isDocsOpen && (
                <div className={styles.docsListWrapper}>
                  {answer.documents.map((doc, i) => {
                    const isExpanded = expandedDocIndices.has(i)
                    const resultStr = typeof doc.result === 'string' ? doc.result : JSON.stringify(doc.result, null, 2)
                    const docCount = Array.isArray(doc.result?.value) ? doc.result.value.length
                      : Array.isArray(doc.result) ? doc.result.length : null
                    return (
                      <div key={i} className={styles.docItem}>
                        <Stack horizontal verticalAlign="center" className={styles.docItemHeader}
                          onClick={() => {
                            const newSet = new Set(expandedDocIndices)
                            isExpanded ? newSet.delete(i) : newSet.add(i)
                            setExpandedDocIndices(newSet)
                          }}>
                          <FontIcon iconName={isExpanded ? 'ChevronDown' : 'ChevronRight'}
                            className={styles.toolCallsChevron} />
                          <span className={styles.docItemLabel}>
                            Iter {doc.iteration} — <strong>{doc.tool}</strong>
                            {docCount !== null && <span className={styles.docCountBadge}>{docCount} docs</span>}
                          </span>
                        </Stack>
                        {isExpanded && (
                          <pre className={styles.docItemContent}>{resultStr}</pre>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          <Stack horizontal className={styles.answerFooter}>
            {!!parsedAnswer.citations.length && (
              <Stack.Item>
                <Stack horizontal verticalAlign="center">
                  <Text className={styles.accordionTitle} onClick={toggleIsRefAccordionOpen} role="button">
                    {parsedAnswer.citations.length > 1
                      ? `${parsedAnswer.citations.length} references`
                      : '1 reference'}
                  </Text>
                  <FontIcon
                    className={styles.accordionIcon}
                    onClick={handleChevronClick}
                    iconName={chevronIsExpanded ? 'ChevronDown' : 'ChevronRight'}
                  />
                </Stack>
              </Stack.Item>
            )}
            <Stack.Item>
              <span className={styles.answerDisclaimer}>AI-generated content may be incorrect</span>
            </Stack.Item>
          </Stack>

          {/* Inline citation list */}
          {chevronIsExpanded && (
            <div className={styles.citationWrapper}>
              {parsedAnswer.citations.map((citation, idx) => {
                const typeLabel = citation.doc_type === 'chunk' ? '📝' : citation.doc_type === 'voc' ? '🎥' : '📁'
                return (
                  <span
                    key={idx}
                    title={createCitationFilepath(citation, idx + 1)}
                    onClick={() => onCitationClicked(citation)}
                    className={styles.citationContainer}>
                    <div className={`${styles.citation} ${
                      citation.doc_type === 'chunk' ? styles.citationChunk :
                      citation.doc_type === 'voc' ? styles.citationVoc :
                      styles.citationProject
                    }`}>
                      {typeLabel}
                    </div>
                    {createCitationFilepath(citation, idx + 1, true)}
                  </span>
                )
              })}
            </div>
          )}
        </Stack.Item>
      </Stack>

      {/* Citation Panel */}
      {parsedAnswer && parsedAnswer.citations.length > 0 && activeCitation && isSubCitationPanelOpen && (
        <Stack.Item className={styles.citationPanel} tabIndex={0} role="tabpanel" aria-label="Citations Panel">
          <Stack
            horizontal
            className={styles.citationPanelHeaderContainer}
            horizontalAlign="space-between"
            verticalAlign="center">
            <span className={styles.citationPanelHeader}>Citations</span>
            <IconButton
              iconProps={{ iconName: 'Cancel' }}
              aria-label="Close citations panel"
              onClick={() => appStateContext?.dispatch({ type: 'CLOSE_ALL_CITATION_PANELS' })}
            />
          </Stack>

          {/* Citation metadata */}
          {activeCitation.metadata && (
            <div className={styles.citationMetadata}>
              {activeCitation.metadata.split(' | ').map((item, i) => (
                <span key={i} className={styles.metadataTag}>{item}</span>
              ))}
            </div>
          )}

          <h5 className={styles.citationPanelTitle} tabIndex={0}>
            {activeCitation.title}
          </h5>
          <div data-citation-timestamp={activeCitationTimestamp}>
            <ReactMarkdown
              linkTarget="_blank"
              className={styles.citationPanelContent}
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}>
              {getHighlightedContent()}
            </ReactMarkdown>
          </div>
        </Stack.Item>
      )}

      <Dialog
        onDismiss={() => {
          resetFeedbackDialog()
          setFeedbackState(Feedback.Neutral)
        }}
        hidden={!isFeedbackDialogOpen}
        styles={{
          main: [{
            selectors: {
              ['@media (min-width: 480px)']: {
                maxWidth: '600px',
                background: '#FFFFFF',
                boxShadow: '0px 14px 28.8px rgba(0, 0, 0, 0.24), 0px 0px 8px rgba(0, 0, 0, 0.2)',
                borderRadius: '8px',
                maxHeight: '600px',
                minHeight: '100px'
              }
            }
          }]
        }}
        dialogContentProps={{ title: 'Submit Feedback', showCloseButton: true }}>
        <Stack tokens={{ childrenGap: 4 }}>
          <div>Your feedback will improve this experience.</div>
          {!showReportInappropriateFeedback ? <UnhelpfulFeedbackContent /> : <ReportInappropriateFeedbackContent />}
          <div>By pressing submit, your feedback will be visible to the application owner.</div>
          <DefaultButton disabled={negativeFeedbackList.length < 1} onClick={onSubmitNegativeFeedback}>
            Submit
          </DefaultButton>
        </Stack>
      </Dialog>
    </>
  )
}
