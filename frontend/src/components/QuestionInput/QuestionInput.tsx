import { useState } from 'react'
import { Stack, TextField } from '@fluentui/react'
import Send from '../../assets/Send.svg'
import styles from './QuestionInput.module.css'

interface Props {
  onSend: (question: string, id?: string) => void
  disabled: boolean
  placeholder?: string
  clearOnSend?: boolean
  conversationId?: string
}

export const QuestionInput = ({ onSend, disabled, placeholder, clearOnSend, conversationId }: Props) => {
  const [question, setQuestion] = useState<string>('')

  const sendQuestion = () => {
    if (disabled || !question.trim()) return
    if (conversationId) {
      onSend(question, conversationId)
    } else {
      onSend(question)
    }
    if (clearOnSend) setQuestion('')
  }

  const onEnterPress = (ev: React.KeyboardEvent<Element>) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      sendQuestion()
    }
  }

  return (
    <Stack horizontal className={styles.questionInputContainer}>
      <TextField
        className={styles.questionInputTextArea}
        placeholder={placeholder}
        multiline
        resizable={false}
        borderless
        value={question}
        onChange={(_ev, newValue) => setQuestion(newValue || '')}
        onKeyDown={onEnterPress}
      />
      <div
        className={styles.questionInputSendButtonContainer}
        role="button"
        tabIndex={0}
        aria-label="Ask question button"
        onClick={sendQuestion}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ' ? sendQuestion() : null)}>
        {disabled ? (
          <span className={styles.questionInputSendButtonDisabled} />
        ) : (
          <img src={Send} className={styles.questionInputSendButton} alt="Send" />
        )}
      </div>
    </Stack>
  )
}
