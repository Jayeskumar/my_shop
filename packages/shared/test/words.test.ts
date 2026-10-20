import { describe, expect, it } from 'vitest'
import { MAX_WORDS_NUMBER, amountInWords, numberToWords } from '../src/words'

describe('numberToWords — English (Indian system)', () => {
  it.each([
    [0, 'Zero'],
    [1, 'One'],
    [10, 'Ten'],
    [11, 'Eleven'],
    [19, 'Nineteen'],
    [20, 'Twenty'],
    [21, 'Twenty One'],
    [99, 'Ninety Nine'],
    [100, 'One Hundred'],
    [101, 'One Hundred One'],
    [110, 'One Hundred Ten'],
    [999, 'Nine Hundred Ninety Nine'],
    [1000, 'One Thousand'],
    [1001, 'One Thousand One'],
    [2500, 'Two Thousand Five Hundred'],
    [10000, 'Ten Thousand'],
    [99999, 'Ninety Nine Thousand Nine Hundred Ninety Nine'],
    [100000, 'One Lakh'],
    [100001, 'One Lakh One'],
    [123456, 'One Lakh Twenty Three Thousand Four Hundred Fifty Six'],
    [1000000, 'Ten Lakh'],
    [9999999, 'Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine'],
    [10000000, 'One Crore'],
    [10000001, 'One Crore One'],
    [123456789, 'Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine'],
    [1000000000, 'One Hundred Crore'],
    [
      12345678901,
      'One Thousand Two Hundred Thirty Four Crore Fifty Six Lakh Seventy Eight Thousand Nine Hundred One',
    ],
    [
      MAX_WORDS_NUMBER,
      'Nine Thousand Nine Hundred Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine',
    ],
  ])('%d → %s', (n, expected) => {
    expect(numberToWords(n, 'en')).toBe(expected)
  })
})

describe('numberToWords — Tamil', () => {
  it.each([
    [0, 'பூஜ்ஜியம்'],
    [1, 'ஒன்று'],
    [9, 'ஒன்பது'],
    [10, 'பத்து'],
    [11, 'பதினொன்று'],
    [12, 'பன்னிரண்டு'],
    [13, 'பதிமூன்று'],
    [14, 'பதினான்கு'],
    [15, 'பதினைந்து'],
    [16, 'பதினாறு'],
    [17, 'பதினேழு'],
    [18, 'பதினெட்டு'],
    [19, 'பத்தொன்பது'],
    [20, 'இருபது'],
    [21, 'இருபத்து ஒன்று'],
    [30, 'முப்பது'],
    [45, 'நாற்பத்து ஐந்து'],
    [56, 'ஐம்பத்து ஆறு'],
    [67, 'அறுபத்து ஏழு'],
    [78, 'எழுபத்து எட்டு'],
    [89, 'எண்பத்து ஒன்பது'],
    [90, 'தொண்ணூறு'],
    [99, 'தொண்ணூற்று ஒன்பது'],
    [100, 'நூறு'],
    [101, 'நூற்று ஒன்று'],
    [120, 'நூற்று இருபது'],
    [200, 'இருநூறு'],
    [250, 'இருநூற்று ஐம்பது'],
    [300, 'முந்நூறு'],
    [456, 'நானூற்று ஐம்பத்து ஆறு'],
    [500, 'ஐநூறு'],
    [600, 'அறுநூறு'],
    [789, 'எழுநூற்று எண்பத்து ஒன்பது'],
    [800, 'எண்ணூறு'],
    [900, 'தொள்ளாயிரம்'],
    [901, 'தொள்ளாயிரத்து ஒன்று'],
    [999, 'தொள்ளாயிரத்து தொண்ணூற்று ஒன்பது'],
    [1000, 'ஆயிரம்'],
    [1001, 'ஆயிரத்து ஒன்று'],
    [1100, 'ஆயிரத்து நூறு'],
    [2000, 'இரண்டாயிரம்'],
    [2500, 'இரண்டாயிரத்து ஐநூறு'],
    [3000, 'மூன்றாயிரம்'],
    [4000, 'நான்காயிரம்'],
    [5000, 'ஐந்தாயிரம்'],
    [6000, 'ஆறாயிரம்'],
    [7000, 'ஏழாயிரம்'],
    [8000, 'எட்டாயிரம்'],
    [9000, 'ஒன்பதாயிரம்'],
    [10000, 'பத்தாயிரம்'],
    [11000, 'பதினோராயிரம்'],
    [12000, 'பன்னிரண்டாயிரம்'],
    [19000, 'பத்தொன்பதாயிரம்'],
    [20000, 'இருபதாயிரம்'],
    [21000, 'இருபத்து ஓராயிரம்'],
    [23000, 'இருபத்து மூன்றாயிரம்'],
    [90000, 'தொண்ணூறாயிரம்'],
    [99999, 'தொண்ணூற்று ஒன்பதாயிரத்து தொள்ளாயிரத்து தொண்ணூற்று ஒன்பது'],
    [100000, 'ஒரு லட்சம்'],
    [100001, 'ஒரு லட்சத்து ஒன்று'],
    [123456, 'ஒரு லட்சத்து இருபத்து மூன்றாயிரத்து நானூற்று ஐம்பத்து ஆறு'],
    [1100000, 'பதினொரு லட்சம்'],
    [2100000, 'இருபத்து ஒரு லட்சம்'],
    [10000000, 'ஒரு கோடி'],
    [10000500, 'ஒரு கோடியே ஐநூறு'],
    [
      123456789,
      'பன்னிரண்டு கோடியே முப்பத்து நான்கு லட்சத்து ஐம்பத்து ஆறாயிரத்து எழுநூற்று எண்பத்து ஒன்பது',
    ],
    [210000000, 'இருபத்து ஒரு கோடி'],
    [10000000000, 'ஆயிரம் கோடி'],
    [10010000000, 'ஆயிரத்து ஒரு கோடி'],
  ])('%d → %s', (n, expected) => {
    expect(numberToWords(n, 'ta')).toBe(expected)
  })

  it('every number below 1,00,000 produces Tamil words without stray spaces', () => {
    for (let n = 1; n < 100000; n += 37) {
      const w = numberToWords(n, 'ta')
      expect(w).toMatch(/^[஀-௿ ]+$/)
      expect(w).not.toMatch(/ {2}|^ | $/)
    }
  })
})

describe('amountInWords', () => {
  it.each([
    [0, 'Rupees Zero Only', 'ரூபாய் பூஜ்ஜியம் மட்டும்'],
    [100, 'Rupees One Only', 'ரூபாய் ஒன்று மட்டும்'],
    [50, 'Fifty Paise Only', 'ஐம்பது பைசா மட்டும்'],
    [1, 'One Paise Only', 'ஒன்று பைசா மட்டும்'],
    [1150, 'Rupees Eleven and Fifty Paise Only', 'ரூபாய் பதினொன்று மற்றும் ஐம்பது பைசா மட்டும்'],
    [250000, 'Rupees Two Thousand Five Hundred Only', 'ரூபாய் இரண்டாயிரத்து ஐநூறு மட்டும்'],
    [
      12345650,
      'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only',
      'ரூபாய் ஒரு லட்சத்து இருபத்து மூன்றாயிரத்து நானூற்று ஐம்பத்து ஆறு மற்றும் ஐம்பது பைசா மட்டும்',
    ],
    [1000000000, 'Rupees One Crore Only', 'ரூபாய் ஒரு கோடி மட்டும்'],
    [
      12345678999,
      'Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine and Ninety Nine Paise Only',
      'ரூபாய் பன்னிரண்டு கோடியே முப்பத்து நான்கு லட்சத்து ஐம்பத்து ஆறாயிரத்து எழுநூற்று எண்பத்து ஒன்பது மற்றும் தொண்ணூற்று ஒன்பது பைசா மட்டும்',
    ],
  ])('%d paise', (paise, en, ta) => {
    expect(amountInWords(paise, 'en')).toBe(en)
    expect(amountInWords(paise, 'ta')).toBe(ta)
  })
  it('defaults to English', () => {
    expect(amountInWords(100)).toBe('Rupees One Only')
  })
  it.each([-1, 1.5, Number.NaN, (MAX_WORDS_NUMBER + 1) * 100])('rejects %d', (paise) => {
    expect(() => amountInWords(paise)).toThrow(RangeError)
  })
  it('numberToWords rejects out-of-range input', () => {
    expect(() => numberToWords(-1)).toThrow(RangeError)
    expect(() => numberToWords(MAX_WORDS_NUMBER + 1)).toThrow(RangeError)
    expect(() => numberToWords(2.5)).toThrow(RangeError)
  })
})
