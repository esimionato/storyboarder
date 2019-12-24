import React, {useState, useRef, useCallback, useEffect} from 'react'
import {connect} from 'react-redux'
import { useDrag } from 'react-use-gesture'
import {Math as _Math} from 'three'

import {
  undoGroupStart,
  undoGroupEnd
} from './../../../shared/reducers/shot-generator'

import useDoubleClick from './../../../hooks/use-double-click'
import useLongPress from './../../../hooks/use-long-press'

export const transforms = {
  // default
  clamp: (value, min, max) => {
    return _Math.clamp(value, min, max)
  },
  degrees: (value) => {
    if (value > 180) { return value - 360 }
    if (value < -180) { return value + 360 }
    return value
  },
  round: (value, min, max) => {
    value = Math.round(value)
    return _Math.clamp(value, min, max)
  }
}

export const formatters = {
  // default
  toFixed2: value => value.toFixed(2),

  identity: value => value,

  degrees: value => Math.round(value).toString() + '°',
  percent: value => Math.round(value).toString() + '%'
}

const getFormattedInputValue = (value, formatter) => {
  if (formatters.hasOwnProperty(formatter)) {
    return parseFloat(formatter(value))
  }
  
  return value
}

const defaultOnSetValue = value => {}

const NumberSliderComponent = React.memo(({
  label,
  value = 0,
  min = -10,
  max = 10,
  step = 0.1, 
  formatter = formatters.toFixed2,
  onSetValue = defaultOnSetValue,
  transform = transforms.clamp,
  onDragStart,
  onDragEnd
}) => {
  const inputRef = useRef(null)
  const [isTextInput, setTextInput] = useState(false)
  const [textInputValue, setTextInputValue] = useState(value)
  
  const onDrag = useCallback(({direction, altKey}) => {
    const nextValue = transform(value + Math.sign(direction) * step * (altKey ? 0.01 : 1.0), min, max)
    
    onSetValue(nextValue)
  }, [value])
  
  const bind = useDrag(({event, first, last}) => {
    if (first) {
      onDragStart()
      
      inputRef.current.requestPointerLock()
    }
    
    onDrag({
      direction: event.movementX,
      altKey: event.altKey
    })

    if (last) {
      document.exitPointerLock()
      onDragEnd()
    }
  }, {dragDelay: true})

  const bindDoubleClick = useDoubleClick(() => {
    setTextInputValue(getFormattedInputValue(value, formatter))
    setTextInput(true)
  })

  const onTextInputBlur = useCallback(() => {
    setTextInput(false)
    setTextInputValue(getFormattedInputValue(value, formatter))
  }, [])

  const onTextInputKey = (event) => {
    if (event.key === 'Escape') {
      // reset
      setTextInput(false)
      setTextInputValue(getFormattedInputValue(value, formatter))
    } else if (event.key === 'Enter') {
      // TODO validation, tranform, error handling
      onSetValue(parseFloat(textInputValue))
      setTextInput(false)
    }
  }

  const onTextInputChange = useCallback((event) => {
    setTextInputValue(event.target.value)
  }, [])

  const onNudge = useCallback((direction, event) => {
    onDrag({
      direction,
      altKey: event.altKey
    })
  }, [value])

  useEffect(() => {
    if (isTextInput && inputRef.current) {
      inputRef.current.focus()
      setImmediate(() => {
        inputRef.current.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length)
      })
    }
  }, [isTextInput, inputRef.current])
  
  return (
      <div className='number-slider'>
        {label ? <div className='number-slider__label'>{label}</div> : null}
        <div
            className='number-slider__control'
        >
          <div
              className='number-slider__nudge number-slider__nudge--left'
              onClick={(event) => onNudge(-1, event)}
          >
            <div className='number-slider__arrow number-slider__arrow--left'/>
          </div>

          { isTextInput 
              ? <input
                  ref={inputRef}
                  type="text"
                  className="number-slider__input number-slider__input--text"
                  value={textInputValue}
                  onBlur={onTextInputBlur}
                  onKeyDown={onTextInputKey}
                  onChange={onTextInputChange}
              /> 
              : <input
                  ref={inputRef}
                  type="text"
                  className="number-slider__input number-slider__input--move"
                  value={formatter(value)}
                  readOnly={true}
                  {...bind()}
                  {...bindDoubleClick}
              />
          }
          
          <div
              className="number-slider__nudge number-slider__nudge--right"
              onClick={() => onNudge(1, event)}
          >
            <div className="number-slider__arrow number-slider__arrow--right"/>
          </div>
        </div>
      </div>
  )
})

const mapDispatchToProps = {
  onDragStart: undoGroupStart,
  onDragEnd: undoGroupEnd
}

export const NumberSlider = connect(null, mapDispatchToProps)(NumberSliderComponent)
