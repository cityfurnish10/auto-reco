// The guard app's vocabulary, in the five languages the warehouses speak.
//
// Chosen in Settings and applied to the whole app. Hindi for NCR, Marathi for
// Mumbai and Pune, Kannada for Bangalore, Telugu for Hyderabad, English
// throughout.
//
// REVIEWED 2026-08-25 and signed off. Warehouse vocabulary is trade language
// rather than dictionary language — "inward" and "outward" especially — so this
// needed a person who speaks it, not a translation engine. It has had one.
// Anything ADDED after that date has not, and should be checked before a guard
// sees it.

export const LANGS = [
  { id: "en", native: "English", en: "English" },
  { id: "hi", native: "हिन्दी", en: "Hindi" },
  { id: "mr", native: "मराठी", en: "Marathi" },
  { id: "kn", native: "ಕನ್ನಡ", en: "Kannada" },
  { id: "te", native: "తెలుగు", en: "Telugu" },
] as const;

export type LangId = (typeof LANGS)[number]["id"];

type Row = Record<LangId, string>;

export const STRINGS: Record<string, Row> = {
  // Added 14 Sep 2026 — not yet reviewed by native speakers.
  vehiclePhoto:{en:"Vehicle photo",hi:"गाड़ी की फोटो",mr:"गाडीचा फोटो",kn:"ವಾಹನದ ಫೋಟೋ",te:"వాహనం ఫోటో"},
  vehicleBeforeWhy:{en:"Before unloading: photograph how the stock is kept in the vehicle.",hi:"उतारने से पहले: गाड़ी में सामान कैसे रखा है, उसकी फोटो लें।",mr:"उतरवण्यापूर्वी: गाडीत माल कसा ठेवला आहे त्याचा फोटो घ्या.",kn:"ಇಳಿಸುವ ಮೊದಲು: ವಾಹನದಲ್ಲಿ ಸರಕು ಹೇಗೆ ಇಟ್ಟಿದೆ ಎಂದು ಫೋಟೋ ತೆಗೆಯಿರಿ.",te:"దించే ముందు: వాహనంలో సరుకు ఎలా ఉంచారో ఫోటో తీయండి."},
  vehicleAfterWhy:{en:"Loading done: photograph how the stock is kept in the vehicle.",hi:"लोडिंग पूरी: गाड़ी में सामान कैसे रखा है, उसकी फोटो लें।",mr:"लोडिंग पूर्ण: गाडीत माल कसा ठेवला आहे त्याचा फोटो घ्या.",kn:"ಲೋಡಿಂಗ್ ಮುಗಿದಿದೆ: ವಾಹನದಲ್ಲಿ ಸರಕು ಹೇಗೆ ಇಟ್ಟಿದೆ ಎಂದು ಫೋಟೋ ತೆಗೆಯಿರಿ.",te:"లోడింగ్ పూర్తి: వాహనంలో సరుకు ఎలా ఉంచారో ఫోటో తీయండి."},
  photoTooDark:{en:"Too dark to see the stock. Use light and retake.",hi:"बहुत अंधेरा है, सामान नहीं दिख रहा। रोशनी करके दोबारा लें।",mr:"खूप अंधार आहे, माल दिसत नाही. उजेड करून पुन्हा घ्या.",kn:"ತುಂಬಾ ಕತ್ತಲೆ, ಸರಕು ಕಾಣುತ್ತಿಲ್ಲ. ಬೆಳಕು ಬಳಸಿ ಮತ್ತೆ ತೆಗೆಯಿರಿ.",te:"చాలా చీకటిగా ఉంది, సరుకు కనిపించడం లేదు. వెలుతురుతో మళ్లీ తీయండి."},
  photoBlurry:{en:"The photo is blurred. Hold still and retake.",hi:"फोटो धुंधली है। फोन स्थिर रखकर दोबारा लें।",mr:"फोटो धूसर आहे. फोन स्थिर धरून पुन्हा घ्या.",kn:"ಫೋಟೋ ಮಸುಕಾಗಿದೆ. ಸ್ಥಿರವಾಗಿ ಹಿಡಿದು ಮತ್ತೆ ತೆಗೆಯಿರಿ.",te:"ఫోటో అస్పష్టంగా ఉంది. స్థిరంగా పట్టుకుని మళ్లీ తీయండి."},
  useAnyway:{en:"Use this photo anyway",hi:"यही फोटो रखें",mr:"हाच फोटो वापरा",kn:"ಇದೇ ಫೋಟೋ ಬಳಸಿ",te:"ఇదే ఫోటో వాడండి"},
  savePhotoScan:{en:"Save and start scanning",hi:"सेव करें और स्कैन शुरू करें",mr:"सेव्ह करा आणि स्कॅन सुरू करा",kn:"ಉಳಿಸಿ ಮತ್ತು ಸ್ಕ್ಯಾನ್ ಪ್ರಾರಂಭಿಸಿ",te:"సేవ్ చేసి స్కాన్ ప్రారంభించండి"},
  savePhotoClose:{en:"Save and close trip",hi:"सेव करें और ट्रिप बंद करें",mr:"सेव्ह करा आणि ट्रिप बंद करा",kn:"ಉಳಿಸಿ ಮತ್ತು ಟ್ರಿಪ್ ಮುಚ್ಚಿ",te:"సేవ్ చేసి ట్రిప్ మూసివేయండి"},
  tripDate:{en:"Date of this trip",hi:"इस ट्रिप की तारीख",mr:"या ट्रिपची तारीख",kn:"ಈ ಟ್ರಿಪ್‌ನ ದಿನಾಂಕ",te:"ఈ ట్రిప్ తేదీ"},
  forToday:{en:"Today",hi:"आज",mr:"आज",kn:"ಇಂದು",te:"ఈరోజు"},
  forYesterday:{en:"Yesterday",hi:"कल (बीता)",mr:"काल",kn:"ನಿನ್ನೆ",te:"నిన్న"},
  lateNote:{en:"Recording for yesterday. It will be marked as entered late.",hi:"कल के लिए दर्ज हो रहा है। इसे देर से दर्ज के रूप में चिह्नित किया जाएगा।",mr:"कालसाठी नोंद होत आहे. उशिरा नोंदवले म्हणून चिन्हांकित होईल.",kn:"ನಿನ್ನೆಗಾಗಿ ದಾಖಲಿಸಲಾಗುತ್ತಿದೆ. ತಡವಾಗಿ ದಾಖಲಿಸಿದ್ದು ಎಂದು ಗುರುತಿಸಲಾಗುತ್ತದೆ.",te:"నిన్నటి కోసం నమోదు అవుతోంది. ఆలస్యంగా నమోదు చేసినట్లు గుర్తించబడుతుంది."},
  shiftExpired:{en:"Your earlier shift was closed because nobody ended it. Please check in again.",hi:"आपकी पिछली शिफ्ट किसी ने खत्म नहीं की, इसलिए बंद कर दी गई। कृपया दोबारा हाज़िरी लगाएं।",mr:"तुमची आधीची शिफ्ट कोणी संपवली नाही म्हणून बंद केली. कृपया पुन्हा हजेरी लावा.",kn:"ಹಿಂದಿನ ಪಾಳಿಯನ್ನು ಯಾರೂ ಮುಗಿಸದ ಕಾರಣ ಮುಚ್ಚಲಾಗಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಹಾಜರಾತಿ ಹಾಕಿ.",te:"మీ గత షిఫ్ట్‌ను ఎవరూ ముగించనందున మూసివేశాం. దయచేసి మళ్లీ హాజరు వేయండి."},
  finalList:{en:"Final list",hi:"अंतिम सूची",mr:"अंतिम यादी",kn:"ಅಂತಿಮ ಪಟ್ಟಿ",te:"తుది జాబితా"},
  finalListWhy:{en:"Check every item against the truck before closing.",hi:"बंद करने से पहले हर आइटम ट्रक से मिलाएं।",mr:"बंद करण्यापूर्वी प्रत्येक वस्तू ट्रकशी जुळवा.",kn:"ಮುಚ್ಚುವ ಮೊದಲು ಪ್ರತಿ ವಸ್ತುವನ್ನು ಟ್ರಕ್‌ನೊಂದಿಗೆ ಹೊಂದಿಸಿ.",te:"మూసివేసే ముందు ప్రతి వస్తువును ట్రక్‌తో సరిచూడండి."},
  confirmClose:{en:"Confirm & close",hi:"पक्का करें और बंद करें",mr:"खात्री करा आणि बंद करा",kn:"ಖಚಿತಪಡಿಸಿ ಮುಚ್ಚಿ",te:"నిర్ధారించి మూసివేయండి"},
  nothingOnTrip:{en:"No items on this trip yet",hi:"इस ट्रिप में अभी कोई आइटम नहीं",mr:"या ट्रिपमध्ये अजून वस्तू नाहीत",kn:"ಈ ಟ್ರಿಪ್‌ನಲ್ಲಿ ಇನ್ನೂ ವಸ್ತುಗಳಿಲ್ಲ",te:"ఈ ట్రిప్‌లో ఇంకా వస్తువులు లేవు"},
  scannedItem:{en:"Scanned item",hi:"स्कैन किया आइटम",mr:"स्कॅन केलेली वस्तू",kn:"ಸ್ಕ್ಯಾನ್ ಮಾಡಿದ ವಸ್ತು",te:"స్కాన్ చేసిన వస్తువు"},
  checkOutPhoto:{en:"End shift — photo",hi:"शिफ्ट खत्म — फोटो",mr:"शिफ्ट संपवा — फोटो",kn:"ಪಾಳಿ ಮುಗಿಸಿ — ಫೋಟೋ",te:"షిఫ్ట్ ముగింపు — ఫోటో"},
  selfieOutWhy:{en:"Confirms it is you ending the shift",hi:"पक्का करता है कि शिफ्ट आप ही खत्म कर रहे हैं",mr:"शिफ्ट तुम्हीच संपवत आहात याची खात्री करते",kn:"ಪಾಳಿ ಮುಗಿಸುತ್ತಿರುವುದು ನೀವೇ ಎಂದು ಖಚಿತಪಡಿಸುತ್ತದೆ",te:"షిఫ్ట్ ముగిస్తున్నది మీరే అని నిర్ధారిస్తుంది"},
  somethingWrong:{en:"Something went wrong",hi:"कुछ गड़बड़ हो गई",mr:"काहीतरी चूक झाली",kn:"ಏನೋ ತಪ್ಪಾಗಿದೆ",te:"ఏదో తప్పు జరిగింది"},
  workIsSafe:{en:"Your work is saved on this phone",hi:"आपका काम इस फोन में सेव है",mr:"तुमचे काम या फोनमध्ये सेव्ह आहे",kn:"ನಿಮ್ಮ ಕೆಲಸ ಈ ಫೋನ್‌ನಲ್ಲಿ ಉಳಿದಿದೆ",te:"మీ పని ఈ ఫోన్‌లో సేవ్ అయింది"},
  deviceRevoked:{en:"This phone is no longer allowed",hi:"इस फोन की अनुमति हटा दी गई है",mr:"या फोनची परवानगी काढली आहे",kn:"ಈ ಫೋನ್‌ಗೆ ಅನುಮತಿ ಇಲ್ಲ",te:"ఈ ఫోన్‌కు అనుమతి లేదు"},
  deviceRevokedWhy:{en:"Ask your manager to pair it again. Anything already saved will still be sent.",hi:"मैनेजर से दोबारा जोड़ने को कहें। जो सेव है वह फिर भी भेजा जाएगा।",mr:"मॅनेजरला पुन्हा जोडायला सांगा. सेव्ह केलेले तरीही पाठवले जाईल.",kn:"ಮ್ಯಾನೇಜರ್‌ಗೆ ಮತ್ತೆ ಜೋಡಿಸಲು ಹೇಳಿ. ಉಳಿಸಿದ್ದು ಹಾಗೂ ಕಳುಹಿಸಲಾಗುತ್ತದೆ.",te:"మేనేజర్‌ను మళ్లీ జత చేయమని అడగండి. సేవ్ అయినవి పంపబడతాయి."},
  queueTitle:{en:"Saved on this phone",hi:"भेजना बाकी",mr:"पाठवायचे बाकी",kn:"ಕಳುಹಿಸಲು ಬಾಕಿ",te:"పంపడానికి పెండింగ్"},
  someRefused:{en:"Some entries were refused",hi:"कुछ एंट्री नहीं ली गईं",mr:"काही नोंदी घेतल्या नाहीत",kn:"ಕೆಲವು ನಮೂದುಗಳು ತಿರಸ್ಕೃತವಾಗಿವೆ",te:"కొన్ని నమోదులు తిరస్కరించబడ్డాయి"},
  someRefusedWhy:{en:"They are kept here so nothing is lost. Show this to your manager, or try sending again.",hi:"ये यहीं रखी हैं ताकि कुछ खोए नहीं। मैनेजर को दिखाएं, या दोबारा भेजकर देखें।",mr:"या इथेच ठेवल्या आहेत जेणेकरून काही हरवणार नाही. मॅनेजरला दाखवा, किंवा पुन्हा पाठवून पाहा.",kn:"ಏನೂ ಕಳೆದುಹೋಗದಂತೆ ಇಲ್ಲಿ ಇಡಲಾಗಿದೆ. ಮ್ಯಾನೇಜರ್‌ಗೆ ತೋರಿಸಿ, ಅಥವಾ ಮತ್ತೆ ಕಳುಹಿಸಿ ನೋಡಿ.",te:"ఏమీ పోకుండా ఇక్కడ ఉంచబడ్డాయి. మేనేజర్‌కు చూపండి, లేదా మళ్లీ పంపి చూడండి."},
  refusedUnclear:{en:"The gate could not accept this. Show your manager.",hi:"गेट ने इसे नहीं लिया। मैनेजर को दिखाएं।",mr:"गेटने हे स्वीकारले नाही. मॅनेजरला दाखवा.",kn:"ಗೇಟ್ ಇದನ್ನು ಸ್ವೀಕರಿಸಲಿಲ್ಲ. ಮ್ಯಾನೇಜರ್‌ಗೆ ತೋರಿಸಿ.",te:"గేట్ దీన్ని స్వీకరించలేదు. మేనేజర్‌కు చూపండి."},
  tryAgain:{en:"Try again",hi:"दोबारा भेजें",mr:"पुन्हा पाठवा",kn:"ಮತ್ತೆ ಕಳುಹಿಸಿ",te:"మళ్లీ పంపండి"},
  starting:{en:"Starting…",hi:"शुरू हो रहा है…",mr:"सुरू होत आहे…",kn:"ಪ್ರಾರಂಭವಾಗುತ್ತಿದೆ…",te:"ప్రారంభమవుతోంది…"},
  history:{en:"Your history",hi:"आपका रिकॉर्ड",mr:"तुमचा रेकॉर्ड",kn:"ನಿಮ್ಮ ದಾಖಲೆ",te:"మీ రికార్డు"},
  viewHistory:{en:"See earlier days",hi:"पिछले दिन देखें",mr:"मागील दिवस पहा",kn:"ಹಿಂದಿನ ದಿನಗಳನ್ನು ನೋಡಿ",te:"గత రోజులు చూడండి"},
  nothingThatDay:{en:"Nothing recorded that day",hi:"उस दिन कुछ दर्ज नहीं",mr:"त्या दिवशी काही नोंद नाही",kn:"ಆ ದಿನ ಏನೂ ದಾಖಲಾಗಿಲ್ಲ",te:"ఆ రోజు ఏమీ నమోదు కాలేదు"},
  photoCheck:{en:"Photo check",hi:"फोटो जाँच",mr:"फोटो तपासणी",kn:"ಫೋಟೋ ಪರಿಶೀಲನೆ",te:"ఫోటో తనిఖీ"},
  stillOnDuty:{en:"Still on duty?",hi:"अभी भी ड्यूटी पर?",mr:"अजून ड्युटीवर?",kn:"ಇನ್ನೂ ಕರ್ತವ್ಯದಲ್ಲಿ?",te:"ఇంకా డ్యూటీలో?"},
  randomCheckWhy:{en:"A quick photo, a couple of times a shift",hi:"शिफ्ट में दो बार एक फोटो",mr:"शिफ्टमध्ये दोनदा एक फोटो",kn:"ಶಿಫ್ಟ್‌ನಲ್ಲಿ ಎರಡು ಬಾರಿ ಒಂದು ಫೋಟೋ",te:"షిఫ్ట్‌లో రెండుసార్లు ఒక ఫోటో"},
  notNow:{en:"Not now",hi:"अभी नहीं",mr:"आता नाही",kn:"ಈಗ ಬೇಡ",te:"ఇప్పుడు కాదు"},
  done:{en:"Done",hi:"हो गया",mr:"झाले",kn:"ಮುಗಿಯಿತು",te:"అయ్యింది"},
  needs:{en:"Still needs",hi:"अभी चाहिए",mr:"अजून हवे",kn:"ಇನ್ನೂ ಬೇಕು",te:"ఇంకా కావాలి"},
  inOrOut:{en:"inward or outward",hi:"अंदर या बाहर",mr:"आत की बाहेर",kn:"ಒಳಗೆ ಅಥವಾ ಹೊರಗೆ",te:"లోపలికి లేదా బయటికి"},
  profile:{en:"Profile",hi:"प्रोफ़ाइल",mr:"प्रोफाइल",kn:"ಪ್ರೊಫೈಲ್",te:"ప్రొఫైల్"},
  employeeCode:{en:"Code",hi:"कोड",mr:"कोड",kn:"ಕೋಡ್",te:"కోడ్"},
  gate:{en:"Gate",hi:"गेट",mr:"गेट",kn:"ಗೇಟ್",te:"గేట్"},
  stillToSend:{en:"Still to send",hi:"अभी भेजना बाकी",mr:"अजून पाठवायचे",kn:"ಇನ್ನೂ ಕಳುಹಿಸಬೇಕು",te:"ఇంకా పంపాలి"},
  kindTrip:{en:"Trip",hi:"ट्रिप",mr:"ट्रिप",kn:"ಟ್ರಿಪ್",te:"ట్రిప్"},
  kindScan:{en:"Item",hi:"आइटम",mr:"वस्तू",kn:"ವಸ್ತು",te:"వస్తువు"},
  kindShift:{en:"Attendance",hi:"हाज़िरी",mr:"हजेरी",kn:"ಹಾಜರಾತಿ",te:"హాజరు"},
  kindFace:{en:"Photo check",hi:"फोटो जाँच",mr:"फोटो तपासणी",kn:"ಫೋಟೋ ಪರಿಶೀಲನೆ",te:"ఫోటో తనిఖీ"},
  takePhoto:{en:"Take a photo",hi:"फोटो लें",mr:"फोटो काढा",kn:"ಫೋಟೋ ತೆಗೆಯಿರಿ",te:"ఫోటో తీయండి"},
  tapToCapture:{en:"Tap to capture",hi:"खींचने के लिए दबाएँ",mr:"काढण्यासाठी दाबा",kn:"ತೆಗೆಯಲು ಒತ್ತಿ",te:"తీయడానికి నొక్కండి"},
  retake:{en:"Retake",hi:"दोबारा लें",mr:"पुन्हा घ्या",kn:"ಮತ್ತೆ ತೆಗೆಯಿರಿ",te:"మళ్లీ తీయండి"},
  faceOk:{en:"Photo matched",hi:"फोटो मिल गई",mr:"फोटो जुळला",kn:"ಫೋಟೋ ಹೊಂದಿಕೆಯಾಯಿತು",te:"ఫోటో సరిపోలింది"},
  faceReview:{en:"Saved — your manager will check this",hi:"सेव हो गया — मैनेजर जाँच लेंगे",mr:"सेव्ह झाले — मॅनेजर तपासतील",kn:"ಉಳಿಸಲಾಗಿದೆ — ಮ್ಯಾನೇಜರ್ ಪರಿಶೀಲಿಸುತ್ತಾರೆ",te:"సేవ్ అయింది — మేనేజర్ తనిఖీ చేస్తారు"},
  // ── The face check refuses ────────────────────────────────────────────
  // Only ever shown for a confident mismatch. It has to be unmistakable
  // WITHOUT accusing the person holding the phone of anything — they may
  // simply be a guard whose enrolment photo is four years and a beard old.
  faceNotYou:{en:"This is not the enrolled face",hi:"यह रजिस्टर किया हुआ चेहरा नहीं है",mr:"हा नोंदवलेला चेहरा नाही",kn:"ಇದು ನೋಂದಾಯಿತ ಮುಖವಲ್ಲ",te:"ఇది నమోదైన ముఖం కాదు"},
  faceBlockedNote:{en:"Cannot check in. Please see your manager.",hi:"चेक-इन नहीं हो सकता। अपने मैनेजर से मिलें।",mr:"चेक-इन होऊ शकत नाही. मॅनेजरला भेटा.",kn:"ಚೆಕ್-ಇನ್ ಸಾಧ್ಯವಿಲ್ಲ. ನಿಮ್ಮ ಮ್ಯಾನೇಜರ್ ಅವರನ್ನು ಭೇಟಿ ಮಾಡಿ.",te:"చెక్-ఇన్ కాదు. మీ మేనేజర్‌ను కలవండి."},
  selfieRequired:{en:"Take your photo to check in",hi:"चेक-इन के लिए अपनी फोटो लें",mr:"चेक-इनसाठी तुमचा फोटो काढा",kn:"ಚೆಕ್-ಇನ್ ಮಾಡಲು ನಿಮ್ಮ ಫೋಟೋ ತೆಗೆಯಿರಿ",te:"చెక్-ఇన్ కోసం మీ ఫోటో తీసుకోండి"},
  faceNotEnrolled:{en:"No reference photo on file — ask your manager to add one",hi:"रेफरेंस फोटो नहीं है — मैनेजर से जुड़वाएँ",mr:"संदर्भ फोटो नाही — मॅनेजरकडून जोडून घ्या",kn:"ಉಲ್ಲೇಖ ಫೋಟೋ ಇಲ್ಲ — ಮ್ಯಾನೇಜರ್ ಅವರನ್ನು ಸೇರಿಸಲು ಕೇಳಿ",te:"రిఫరెన్స్ ఫోటో లేదు — మేనేజర్‌ను జోడించమని అడగండి"},

  // ── Removing something already scanned ────────────────────────────────
  removeItem:{en:"Remove this item?",hi:"यह आइटम हटाएँ?",mr:"ही वस्तू काढायची?",kn:"ಈ ವಸ್ತುವನ್ನು ತೆಗೆಯುವುದೇ?",te:"ఈ వస్తువును తీసివేయాలా?"},
  removeWhy:{en:"It will not count in this trip. Scan it again if it really moved.",hi:"यह इस ट्रिप में नहीं गिना जाएगा। अगर सच में गया है तो दोबारा स्कैन करें।",mr:"ही या ट्रिपमध्ये मोजली जाणार नाही. खरंच गेली असेल तर पुन्हा स्कॅन करा.",kn:"ಇದು ಈ ಟ್ರಿಪ್‌ನಲ್ಲಿ ಎಣಿಕೆಯಾಗುವುದಿಲ್ಲ. ನಿಜವಾಗಿ ಹೋಗಿದ್ದರೆ ಮತ್ತೆ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ.",te:"ఇది ఈ ట్రిప్‌లో లెక్కించబడదు. నిజంగా వెళ్లితే మళ్లీ స్కాన్ చేయండి."},
  remove:{en:"Remove",hi:"हटाएँ",mr:"काढा",kn:"ತೆಗೆಯಿರಿ",te:"తీసివేయండి"},
  keepIt:{en:"Keep it",hi:"रहने दें",mr:"राहू द्या",kn:"ಇರಲಿ",te:"ఉంచండి"},
  removed:{en:"Removed",hi:"हटा दिया",mr:"काढले",kn:"ತೆಗೆಯಲಾಗಿದೆ",te:"తీసివేయబడింది"},

  // ── What the plan says is on this truck ───────────────────────────────
  plannedOnThis:{en:"Planned on this vehicle",hi:"इस गाड़ी में तय है",mr:"या गाडीत नियोजित",kn:"ಈ ವಾಹನದಲ್ಲಿ ನಿಗದಿ",te:"ఈ వాహనంలో ప్లాన్"},
  plannedTask:{en:"Delivery task",hi:"डिलीवरी टास्क",mr:"डिलिव्हरी टास्क",kn:"ಡೆಲಿವರಿ ಕೆಲಸ",te:"డెలివరీ టాస్క్"},

  // ── Ending the day ────────────────────────────────────────────────────
  // Reachable in one tap, because the only way to end a shift used to be a
  // button labelled "switch guard" — so guards pocketed the phone instead and
  // the attendance record never closed.
  endShift:{en:"End my shift",hi:"शिफ्ट खत्म करें",mr:"शिफ्ट संपवा",kn:"ಪಾಳಿ ಮುಗಿಸಿ",te:"షిఫ్ట్ ముగించండి"},
  endShiftQ:{en:"Finished for the day?",hi:"आज का काम खत्म?",mr:"आजचे काम संपले?",kn:"ಇಂದಿನ ಕೆಲಸ ಮುಗಿಯಿತೇ?",te:"ఈరోజు పని పూర్తయిందా?"},
  endShiftWhy:{en:"Your attendance will be recorded as ending now.",hi:"आपकी हाज़िरी अभी बंद हो जाएगी।",mr:"तुमची हजेरी आता बंद होईल.",kn:"ನಿಮ್ಮ ಹಾಜರಾತಿ ಈಗ ಮುಗಿಯುತ್ತದೆ.",te:"మీ హాజరు ఇప్పుడు ముగుస్తుంది."},
  tripStillOpen:{en:"A trip is still open",hi:"एक ट्रिप अभी खुली है",mr:"एक ट्रिप अजून सुरू आहे",kn:"ಒಂದು ಟ್ರಿಪ್ ಇನ್ನೂ ತೆರೆದಿದೆ",te:"ఒక ట్రిప్ ఇంకా తెరిచి ఉంది"},
  tripStillOpenWhy:{en:"Close it first, or it will be marked unfinished.",hi:"पहले उसे बंद करें, वरना अधूरी मानी जाएगी।",mr:"आधी ती बंद करा, नाहीतर अपूर्ण मानली जाईल.",kn:"ಮೊದಲು ಅದನ್ನು ಮುಚ್ಚಿ, ಇಲ್ಲದಿದ್ದರೆ ಅಪೂರ್ಣವೆಂದು ಗುರುತಿಸಲಾಗುತ್ತದೆ.",te:"ముందు దాన్ని మూసివేయండి, లేకపోతే అసంపూర్ణంగా గుర్తించబడుతుంది."},

  // ── No signal, mid-scan ───────────────────────────────────────────────
  // Scanning keeps working; the guard is told, not stopped. A gate with no
  // signal is the case this app was built for.
  offlineScanning:{en:"No internet — still saving",hi:"इंटरनेट नहीं — फिर भी सेव हो रहा है",mr:"इंटरनेट नाही — तरीही सेव्ह होत आहे",kn:"ಇಂಟರ್ನೆಟ್ ಇಲ್ಲ — ಆದರೂ ಉಳಿಸಲಾಗುತ್ತಿದೆ",te:"ఇంటర్నెట్ లేదు — అయినా సేవ్ అవుతోంది"},
  offlineScanningWhy:{en:"Keep scanning. Reconnect before you finish.",hi:"स्कैन करते रहें। खत्म करने से पहले इंटरनेट जोड़ें।",mr:"स्कॅन करत राहा. संपवण्याआधी इंटरनेट जोडा.",kn:"ಸ್ಕ್ಯಾನ್ ಮುಂದುವರಿಸಿ. ಮುಗಿಸುವ ಮೊದಲು ಇಂಟರ್ನೆಟ್ ಸಂಪರ್ಕಿಸಿ.",te:"స్కాన్ కొనసాగించండి. ముగించే ముందు ఇంటర్నెట్ కనెక్ట్ చేయండి."},
  offlineAtClose:{en:"These are on this phone only",hi:"ये सिर्फ इस फोन में हैं",mr:"हे फक्त या फोनमध्ये आहेत",kn:"ಇವು ಈ ಫೋನ್‌ನಲ್ಲಿ ಮಾತ್ರ ಇವೆ",te:"ఇవి ఈ ఫోన్‌లో మాత్రమే ఉన్నాయి"},
  sendNow:{en:"Try sending now",hi:"अभी भेजने की कोशिश करें",mr:"आता पाठवण्याचा प्रयत्न करा",kn:"ಈಗ ಕಳುಹಿಸಲು ಪ್ರಯತ್ನಿಸಿ",te:"ఇప్పుడు పంపడానికి ప్రయత్నించండి"},
  offlineAtCloseWhy:{en:"Connect to the internet so they reach the office. They will send by themselves once you do.",hi:"इंटरनेट जोड़ें ताकि ये ऑफिस पहुँचें। जुड़ते ही अपने आप चले जाएँगे।",mr:"इंटरनेट जोडा म्हणजे हे ऑफिसला पोहोचतील. जोडताच आपोआप जातील.",kn:"ಇಂಟರ್ನೆಟ್ ಸಂಪರ್ಕಿಸಿ, ಇವು ಕಚೇರಿಗೆ ತಲುಪುತ್ತವೆ. ಸಂಪರ್ಕವಾದ ತಕ್ಷಣ ತಾವಾಗಿಯೇ ಹೋಗುತ್ತವೆ.",te:"ఇంటర్నెట్ కనెక్ట్ చేయండి, ఇవి ఆఫీసుకు చేరతాయి. కనెక్ట్ అయిన వెంటనే వాటంతట అవే వెళ్తాయి."},

  // ── Signing out of a shared phone ─────────────────────────────────────
  // Not the same as ending a shift, and the wording keeps them apart: this
  // hands the handset to a colleague and leaves the attendance record open.
  signOut:{en:"Sign out",hi:"साइन आउट",mr:"साइन आउट",kn:"ಸೈನ್ ಔಟ್",te:"సైన్ అవుట్"},
  signOutQ:{en:"Sign out of this phone?",hi:"इस फोन से साइन आउट करें?",mr:"या फोनवरून साइन आउट करायचे?",kn:"ಈ ಫೋನ್‌ನಿಂದ ಸೈನ್ ಔಟ್ ಮಾಡುವುದೇ?",te:"ఈ ఫోన్ నుండి సైన్ అవుట్ చేయాలా?"},
  signOutWhy:{en:"Your shift stays open. Use \u201cEnd my shift\u201d if you are finished for the day.",hi:"आपकी शिफ्ट चालू रहेगी। दिन खत्म हो गया हो तो \u201cशिफ्ट खत्म करें\u201d चुनें।",mr:"तुमची शिफ्ट चालू राहील. दिवस संपला असेल तर \u201cशिफ्ट संपवा\u201d निवडा.",kn:"ನಿಮ್ಮ ಪಾಳಿ ತೆರೆದಿರುತ್ತದೆ. ದಿನ ಮುಗಿದಿದ್ದರೆ \u201cಪಾಳಿ ಮುಗಿಸಿ\u201d ಆರಿಸಿ.",te:"మీ షిఫ్ట్ తెరిచే ఉంటుంది. రోజు ముగిస్తే \u201cషిఫ్ట్ ముగించండి\u201d ఎంచుకోండి."},
  stillToSendWhy:{en:"These stay on the phone and will send by themselves.",hi:"ये फोन में रहेंगे और अपने आप चले जाएँगे।",mr:"हे फोनमध्ये राहतील आणि आपोआप जातील.",kn:"ಇವು ಫೋನ್‌ನಲ್ಲಿ ಉಳಿದು ತಾವಾಗಿಯೇ ಕಳುಹಿಸಲ್ಪಡುತ್ತವೆ.",te:"ఇవి ఫోన్‌లో ఉండి వాటంతట అవే పంపబడతాయి."},

  // ── A shift where nothing moved ───────────────────────────────────────
  // The reconciler treats a gate with no scans as a source that FAILED, not as
  // a quiet day — so a guard needs a way to say the difference out loud.
  nothingMoved:{en:"Nothing moved this shift",hi:"इस शिफ्ट में कुछ नहीं आया-गया",mr:"या शिफ्टमध्ये काहीही आले-गेले नाही",kn:"ಈ ಪಾಳಿಯಲ್ಲಿ ಏನೂ ಬಂದಿಲ್ಲ-ಹೋಗಿಲ್ಲ",te:"ఈ షిఫ్ట్‌లో ఏమీ రాలేదు-వెళ్లలేదు"},
  nothingMovedWhy:{en:"Tell us the gate was quiet, so an empty day is not mistaken for a broken phone.",hi:"बताएं कि गेट पर कोई हलचल नहीं थी, ताकि खाली दिन को खराब फोन न समझा जाए।",mr:"गेटवर काही हालचाल नव्हती हे कळवा, म्हणजे रिकामा दिवस बिघडलेला फोन समजला जाणार नाही.",kn:"ಗೇಟ್ ಶಾಂತವಾಗಿತ್ತು ಎಂದು ತಿಳಿಸಿ, ಖಾಲಿ ದಿನವನ್ನು ಕೆಟ್ಟ ಫೋನ್ ಎಂದು ತಪ್ಪಾಗಿ ಭಾವಿಸದಂತೆ.",te:"గేట్ నిశ్శబ్దంగా ఉందని చెప్పండి, ఖాళీ రోజును పాడైన ఫోన్‌గా పొరపాటుగా భావించకుండా."},
  nothingMovedDone:{en:"Recorded — the gate was quiet",hi:"दर्ज हो गया — गेट शांत था",mr:"नोंदवले — गेट शांत होते",kn:"ದಾಖಲಾಗಿದೆ — ಗೇಟ್ ಶಾಂತವಾಗಿತ್ತು",te:"నమోదైంది — గేట్ నిశ్శబ్దంగా ఉంది"},

  // ── The completeness check at trip close ──────────────────────────────
  // Phrased as information, not accusation. The guard is usually not the
  // person who decided what went on the truck, and the commonest cause of a
  // gap is a plan that changed — so it says what the plan expected, and lets
  // them get on with it.
  stillMissing:{en:"Still on the plan",hi:"प्लान में अभी बाकी",mr:"प्लॅनमध्ये अजून बाकी",kn:"ಯೋಜನೆಯಲ್ಲಿ ಇನ್ನೂ ಬಾಕಿ",te:"ప్లాన్‌లో ఇంకా మిగిలింది"},
  missingWhy:{en:"These were planned but not scanned. Add them if they are on the truck, or close anyway.",hi:"ये प्लान में थे पर स्कैन नहीं हुए। गाड़ी में हैं तो जोड़ें, वरना ऐसे ही बंद करें।",mr:"हे प्लॅनमध्ये होते पण स्कॅन झाले नाहीत. गाडीत असतील तर जोडा, नाहीतर तसेच बंद करा.",kn:"ಇವು ಯೋಜನೆಯಲ್ಲಿದ್ದವು ಆದರೆ ಸ್ಕ್ಯಾನ್ ಆಗಿಲ್ಲ. ಲಾರಿಯಲ್ಲಿದ್ದರೆ ಸೇರಿಸಿ, ಇಲ್ಲದಿದ್ದರೆ ಹಾಗೆಯೇ ಮುಚ್ಚಿ.",te:"ఇవి ప్లాన్‌లో ఉన్నాయి కానీ స్కాన్ కాలేదు. ట్రక్‌లో ఉంటే జోడించండి, లేకపోతే అలాగే మూసివేయండి."},
  againstPlan:{en:"Against the plan",hi:"प्लान के मुक़ाबले",mr:"प्लॅनच्या तुलनेत",kn:"ಯೋಜನೆಗೆ ಹೋಲಿಸಿದರೆ",te:"ప్లాన్‌తో పోలిస్తే"},
  more:{en:"more",hi:"और",mr:"आणखी",kn:"ಇನ್ನಷ್ಟು",te:"మరిన్ని"},

  // ── Last-minute additions on the close screen ─────────────────────────
  lastMinute:{en:"Something loaded at the last minute?",hi:"आख़िरी वक़्त पर कुछ और चढ़ा?",mr:"शेवटच्या क्षणी काही चढवले?",kn:"ಕೊನೆಯ ಕ್ಷಣದಲ್ಲಿ ಏನಾದರೂ ಹತ್ತಿಸಿದ್ದೀರಾ?",te:"చివరి నిమిషంలో ఏదైనా ఎక్కించారా?"},

  // ── Vehicle / agent pickers ───────────────────────────────────────────
  pickVehicle:{en:"Choose the vehicle",hi:"गाड़ी चुनें",mr:"गाडी निवडा",kn:"ವಾಹನವನ್ನು ಆರಿಸಿ",te:"వాహనాన్ని ఎంచుకోండి"},
  pickAgent:{en:"Choose the delivery agent",hi:"डिलीवरी एजेंट चुनें",mr:"डिलिव्हरी एजंट निवडा",kn:"ಡೆಲಿವರಿ ಏಜೆಂಟ್ ಆರಿಸಿ",te:"డెలివరీ ఏజెంట్‌ను ఎంచుకోండి"},
  typeItIn:{en:"Not listed — type it in",hi:"सूची में नहीं — खुद लिखें",mr:"यादीत नाही — स्वतः लिहा",kn:"ಪಟ್ಟಿಯಲ್ಲಿಲ್ಲ — ನೀವೇ ಬರೆಯಿರಿ",te:"జాబితాలో లేదు — మీరే టైప్ చేయండి"},
  backToList:{en:"Back to the list",hi:"सूची पर वापस",mr:"यादीकडे परत",kn:"ಪಟ್ಟಿಗೆ ಹಿಂತಿರುಗಿ",te:"జాబితాకు తిరిగి"},
  scheduledToday:{en:"Scheduled today",hi:"आज शेड्यूल",mr:"आज नियोजित",kn:"ಇಂದು ನಿಗದಿ",te:"ఈరోజు షెడ్యూల్"},
  noFleetYet:{en:"Nothing scheduled found — type it in",hi:"कोई शेड्यूल नहीं मिला — खुद लिखें",mr:"नियोजित काही मिळाले नाही — स्वतः लिहा",kn:"ನಿಗದಿತವಾದದ್ದು ಸಿಗಲಿಲ್ಲ — ನೀವೇ ಬರೆಯಿರಿ",te:"షెడ్యూల్ ఏదీ దొరకలేదు — మీరే టైప్ చేయండి"},

  // ── The photo box ─────────────────────────────────────────────────────
  takePicture:{en:"Take picture",hi:"फोटो लें",mr:"फोटो काढा",kn:"ಫೋಟೋ ತೆಗೆಯಿರಿ",te:"ఫోటో తీయండి"},
  photoNeeded:{en:"A photo is required",hi:"फोटो ज़रूरी है",mr:"फोटो आवश्यक आहे",kn:"ಫೋಟೋ ಅಗತ್ಯ",te:"ఫోటో అవసరం"},

  faceNone:{en:"No face found — try again in better light",hi:"चेहरा नहीं दिखा — बेहतर रोशनी में दोबारा लें",mr:"चेहरा दिसला नाही — चांगल्या उजेडात पुन्हा घ्या",kn:"ಮುಖ ಕಾಣಲಿಲ್ಲ — ಒಳ್ಳೆಯ ಬೆಳಕಿನಲ್ಲಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ",te:"ముఖం కనిపించలేదు — మంచి వెలుతురులో మళ్లీ ప్రయత్నించండి"},
  whoAreYou:{en:"Who is on duty?",hi:"ड्यूटी पर कौन है?",mr:"ड्युटीवर कोण आहे?",kn:"ಕರ್ತವ್ಯದಲ್ಲಿ ಯಾರಿದ್ದಾರೆ?",te:"డ్యూటీలో ఎవరు ఉన్నారు?"},
  tapYourName:{en:"Tap your name",hi:"अपना नाम चुनें",mr:"तुमचे नाव निवडा",kn:"ನಿಮ್ಮ ಹೆಸರು ಆಯ್ಕೆಮಾಡಿ",te:"మీ పేరు ఎంచుకోండి"},
  noGuards:{en:"No guards have been added for this gate yet.",hi:"इस गेट के लिए अभी कोई गार्ड नहीं जोड़ा गया है।",mr:"या गेटसाठी अजून कोणताही गार्ड जोडलेला नाही.",kn:"ಈ ಗೇಟ್‌ಗೆ ಇನ್ನೂ ಯಾವುದೇ ಗಾರ್ಡ್ ಸೇರಿಸಿಲ್ಲ.",te:"ఈ గేట్‌కు ఇంకా ఏ గార్డ్‌ను చేర్చలేదు."},
  switchGuard:{en:"Switch guard",hi:"गार्ड बदलें",mr:"गार्ड बदला",kn:"ಗಾರ್ಡ್ ಬದಲಿಸಿ",te:"గార్డ్ మార్చండి"},
  appName:{en:"Gate Check",hi:"गेट रजिस्टर",mr:"गेट रजिस्टर",kn:"ಗೇಟ್ ರಿಜಿಸ್ಟರ್",te:"గేట్ రిజిస్టర్"},
  enterPin:{en:"Enter PIN",hi:"पिन डालें",mr:"पिन टाका",kn:"ಪಿನ್ ನಮೂದಿಸಿ",te:"పిన్ నమోదు చేయండి"},
  wrongPin:{en:"Wrong PIN",hi:"गलत पिन",mr:"चुकीचा पिन",kn:"ತಪ್ಪು ಪಿನ್",te:"తప్పు పిన్"},
  pinHint:{en:"Ask your manager if you have forgotten it",hi:"भूल गए हों तो मैनेजर से पूछें",mr:"विसरला असाल तर मॅनेजरला विचारा",kn:"ಮರೆತಿದ್ದರೆ ಮ್ಯಾನೇಜರ್ ಅವರನ್ನು ಕೇಳಿ",te:"మరచిపోతే మేనేజర్‌ను అడగండి"},
  checkIn:{en:"Check in",hi:"हाज़िरी लगाएं",mr:"हजेरी लावा",kn:"ಹಾಜರಾತಿ ಹಾಕಿ",te:"హాజరు వేయండి"},
  checkOut:{en:"Check out",hi:"छुट्टी करें",mr:"सुट्टी करा",kn:"ಚೆಕ್ ಔಟ್",te:"చెక్ అవుట్"},
  takeSelfie:{en:"Take your photo",hi:"अपनी फोटो लें",mr:"तुमचा फोटो काढा",kn:"ನಿಮ್ಮ ಫೋಟೋ ತೆಗೆಯಿರಿ",te:"మీ ఫోటో తీసుకోండి"},
  selfieWhy:{en:"Confirms you are on duty",hi:"पक्का करता है कि आप ड्यूटी पर हैं",mr:"तुम्ही ड्युटीवर आहात याची खात्री करते",kn:"ನೀವು ಕರ್ತವ್ಯದಲ್ಲಿದ್ದೀರಿ ಎಂದು ಖಚಿತಪಡಿಸುತ್ತದೆ",te:"మీరు డ్యూటీలో ఉన్నారని నిర్ధారిస్తుంది"},
  atGate:{en:"At the gate",hi:"गेट पर",mr:"गेटवर",kn:"ಗೇಟ್‌ನಲ್ಲಿ",te:"గేట్ వద్ద"},
  notAtGate:{en:"Not at the gate",hi:"गेट पर नहीं",mr:"गेटवर नाही",kn:"ಗೇಟ್‌ನಲ್ಲಿ ಇಲ್ಲ",te:"గేట్ వద్ద లేరు"},
  locUnknown:{en:"Location unavailable",hi:"लोकेशन नहीं मिली",mr:"लोकेशन मिळाले नाही",kn:"ಸ್ಥಳ ಸಿಗಲಿಲ್ಲ",te:"లొకేషన్ దొరకలేదు"},
  today:{en:"Today",hi:"आज",mr:"आज",kn:"ಇಂದು",te:"ఈరోజు"},
  onDuty:{en:"On duty",hi:"ड्यूटी पर",mr:"ड्युटीवर",kn:"ಕರ್ತವ್ಯದಲ್ಲಿ",te:"డ్యూటీలో"},
  since:{en:"Since",hi:"से",mr:"पासून",kn:"ಇಂದ",te:"నుండి"},
  tripsToday:{en:"Trips today",hi:"आज की ट्रिप",mr:"आजच्या ट्रिप",kn:"ಇಂದಿನ ಟ್ರಿಪ್‌ಗಳು",te:"ఈరోజు ట్రిప్‌లు"},
  itemsToday:{en:"Items today",hi:"आज के आइटम",mr:"आजच्या वस्तू",kn:"ಇಂದಿನ ವಸ್ತುಗಳು",te:"ఈరోజు వస్తువులు"},
  startTrip:{en:"Start trip",hi:"ट्रिप शुरू करें",mr:"ट्रिप सुरू करा",kn:"ಟ್ರಿಪ್ ಪ್ರಾರಂಭಿಸಿ",te:"ట్రిప్ ప్రారంభించండి"},
  resumeTrip:{en:"Resume trip",hi:"ट्रिप जारी रखें",mr:"ट्रिप सुरू ठेवा",kn:"ಟ್ರಿಪ್ ಮುಂದುವರಿಸಿ",te:"ట్రిప్ కొనసాగించండి"},
  inward:{en:"Inward",hi:"अंदर",mr:"आत",kn:"ಒಳಗೆ",te:"లోపలికి"},
  outward:{en:"Outward",hi:"बाहर",mr:"बाहेर",kn:"ಹೊರಗೆ",te:"బయటికి"},
  vehicleNo:{en:"Vehicle number",hi:"गाड़ी नंबर",mr:"गाडी नंबर",kn:"ವಾಹನ ಸಂಖ್ಯೆ",te:"వాహన నంబర్"},
  deliveryAgent:{en:"Delivery agent",hi:"डिलीवरी एजेंट",mr:"डिलिव्हरी एजंट",kn:"ಡೆಲಿವರಿ ಏಜೆಂಟ್",te:"డెలివరీ ఏజెంట్"},
  vehNote:{en:"Every movement travels on a vehicle. The number is required.",hi:"हर सामान गाड़ी से ही जाता है। नंबर डालना जरूरी है।",mr:"प्रत्येक माल गाडीनेच जातो. नंबर टाकणे आवश्यक आहे.",kn:"ಪ್ರತಿ ಸರಕು ವಾಹನದಲ್ಲೇ ಹೋಗುತ್ತದೆ. ಸಂಖ್ಯೆ ಕಡ್ಡಾಯ.",te:"ప్రతి సరుకు వాహనంలోనే వెళ్తుంది. నంబర్ తప్పనిసరి."},
  startScanning:{en:"Start scanning",hi:"स्कैन शुरू करें",mr:"स्कॅन सुरू करा",kn:"ಸ್ಕ್ಯಾನ್ ಪ್ರಾರಂಭಿಸಿ",te:"స్కాన్ ప్రారంభించండి"},
  pointAtCode:{en:"Point at the barcode",hi:"बारकोड पर कैमरा रखें",mr:"बारकोडवर कॅमेरा धरा",kn:"ಬಾರ್‌ಕೋಡ್ ಮೇಲೆ ಕ್ಯಾಮೆರಾ ಹಿಡಿಯಿರಿ",te:"బార్‌కోడ్‌పై కెమెరా పెట్టండి"},
  itemsScanned:{en:"items scanned",hi:"आइटम स्कैन हुए",mr:"वस्तू स्कॅन झाल्या",kn:"ವಸ್ತುಗಳು ಸ್ಕ್ಯಾನ್ ಆಗಿವೆ",te:"వస్తువులు స్కాన్ అయ్యాయి"},
  alreadyScanned:{en:"Already scanned",hi:"पहले ही स्कैन हो चुका",mr:"आधीच स्कॅन झाले आहे",kn:"ಈಗಾಗಲೇ ಸ್ಕ್ಯಾನ್ ಆಗಿದೆ",te:"ఇప్పటికే స్కాన్ అయింది"},
  doneScanning:{en:"Done",hi:"हो गया",mr:"झाले",kn:"ಮುಗಿಯಿತು",te:"అయిపోయింది"},
  notOnList:{en:"Not on today's list",hi:"आज की सूची में नहीं",mr:"आजच्या यादीत नाही",kn:"ಇಂದಿನ ಪಟ್ಟಿಯಲ್ಲಿ ಇಲ್ಲ",te:"నేటి జాబితాలో లేదు"},
  whyLeaving:{en:"Why is this item moving?",hi:"यह सामान क्यों जा रहा है?",mr:"ही वस्तू का जात आहे?",kn:"ಈ ವಸ್ತು ಏಕೆ ಚಲಿಸುತ್ತಿದೆ?",te:"ఈ వస్తువు ఎందుకు కదులుతోంది?"},
  photoRequired:{en:"Photo required",hi:"फोटो जरूरी है",mr:"फोटो आवश्यक",kn:"ಫೋಟೋ ಕಡ್ಡಾಯ",te:"ఫోటో తప్పనిసరి"},
  photoTaken:{en:"Photo taken",hi:"फोटो ले ली",mr:"फोटो घेतला",kn:"ಫೋಟೋ ತೆಗೆಯಲಾಗಿದೆ",te:"ఫోటో తీయబడింది"},
  allowIt:{en:"Allow",hi:"जाने दें",mr:"जाऊ द्या",kn:"ಅನುಮತಿಸಿ",te:"అనుమతించండి"},
  cancel:{en:"Cancel",hi:"रद्द करें",mr:"रद्द करा",kn:"ರದ್ದುಮಾಡಿ",te:"రద్దు చేయండి"},
  addManually:{en:"Add manually",hi:"हाथ से जोड़ें",mr:"हाताने जोडा",kn:"ಕೈಯಿಂದ ಸೇರಿಸಿ",te:"చేతితో జోడించండి"},
  whatIsIt:{en:"What is it?",hi:"यह क्या है?",mr:"हे काय आहे?",kn:"ಇದು ಏನು?",te:"ఇది ఏమిటి?"},
  change:{en:"Change",hi:"बदलें",mr:"बदला",kn:"ಬದಲಿಸಿ",te:"మార్చండి"},
  quantity:{en:"Quantity",hi:"कितने",mr:"किती",kn:"ಎಷ್ಟು",te:"ఎన్ని"},
  comments:{en:"Comments",hi:"टिप्पणी",mr:"टिप्पणी",kn:"ಟಿಪ್ಪಣಿ",te:"వ్యాఖ్య"},
  serialOrOrder:{en:"Serial or order number",hi:"सीरियल या ऑर्डर नंबर",mr:"सीरियल किंवा ऑर्डर नंबर",kn:"ಸೀರಿಯಲ್ ಅಥವಾ ಆರ್ಡರ್ ಸಂಖ್ಯೆ",te:"సీరియల్ లేదా ఆర్డర్ నంబర్"},
  hasSticker:{en:"Does it have a barcode sticker?",hi:"क्या इस पर बारकोड स्टिकर है?",mr:"यावर बारकोड स्टिकर आहे का?",kn:"ಇದರ ಮೇಲೆ ಬಾರ್‌ಕೋಡ್ ಸ್ಟಿಕರ್ ಇದೆಯೇ?",te:"దీనిపై బార్‌కోడ్ స్టిక్కర్ ఉందా?"},
  stickerWhy:{en:"A returning item should already have one.",hi:"वापस आने वाले सामान पर पहले से होना चाहिए।",mr:"परत येणाऱ्या वस्तूवर आधीच असायला हवे.",kn:"ಹಿಂತಿರುಗುವ ವಸ್ತುವಿನ ಮೇಲೆ ಈಗಾಗಲೇ ಇರಬೇಕು.",te:"తిరిగి వచ్చే వస్తువుపై ఇప్పటికే ఉండాలి."},
  yesScanIt:{en:"Yes — scan it",hi:"हाँ — स्कैन करें",mr:"होय — स्कॅन करा",kn:"ಹೌದು — ಸ್ಕ್ಯಾನ್ ಮಾಡಿ",te:"అవును — స్కాన్ చేయండి"},
  noSticker:{en:"No sticker",hi:"स्टिकर नहीं है",mr:"स्टिकर नाही",kn:"ಸ್ಟಿಕರ್ ಇಲ್ಲ",te:"స్టిక్కర్ లేదు"},
  stickerMissing:{en:"Sticker missing",hi:"स्टिकर गायब है",mr:"स्टिकर गहाळ आहे",kn:"ಸ್ಟಿಕರ್ ಇಲ್ಲ",te:"స్టిక్కర్ లేదు"},
  stickerMissingWhy:{en:"This unit was tagged when it left. Your manager will be told so it can be re-tagged.",hi:"जाते समय इस पर स्टिकर था। मैनेजर को बताया जाएगा ताकि दोबारा लगाया जा सके।",mr:"जाताना यावर स्टिकर होते. मॅनेजरला कळवले जाईल जेणेकरून पुन्हा लावता येईल.",kn:"ಹೋಗುವಾಗ ಇದರ ಮೇಲೆ ಸ್ಟಿಕರ್ ಇತ್ತು. ಮತ್ತೆ ಹಾಕಲು ಮ್ಯಾನೇಜರ್‌ಗೆ ತಿಳಿಸಲಾಗುವುದು.",te:"వెళ్లేటప్పుడు దీనిపై స్టిక్కర్ ఉంది. మళ్లీ వేయడానికి మేనేజర్‌కు తెలియజేయబడుతుంది."},
  // "New PO" by operations' own name for it (14 Sep 2026): stock arriving
  // against a purchase order. Stored kind is still vendor_goods — only the
  // label changed, so nothing already recorded needs touching.
  catVendor:{en:"New PO",hi:"नया PO",mr:"नवीन PO",kn:"ಹೊಸ PO",te:"కొత్త PO"},
  catReturn:{en:"Return from pickup",hi:"पिकअप से वापसी",mr:"पिकअपमधून परत",kn:"ಪಿಕಪ್‌ನಿಂದ ಹಿಂತಿರುಗಿದ್ದು",te:"పికప్ నుండి తిరిగి"},
  catSpare:{en:"Spare part",hi:"स्पेयर पार्ट",mr:"स्पेअर पार्ट",kn:"ಬಿಡಿ ಭಾಗ",te:"స్పేర్ పార్ట్"},
  catConsum:{en:"Consumable",hi:"खर्च होने वाला सामान",mr:"वापरून संपणारे सामान",kn:"ಬಳಕೆಯ ಸಾಮಗ್ರಿ",te:"వినియోగ సామగ్రి"},
  catPP:{en:"Packing box",hi:"पैकिंग बॉक्स",mr:"पॅकिंग बॉक्स",kn:"ಪ್ಯಾಕಿಂಗ್ ಬಾಕ್ಸ್",te:"ప్యాకింగ్ బాక్స్"},
  catSample:{en:"Sample item",hi:"सैंपल सामान",mr:"नमुना वस्तू",kn:"ಮಾದರಿ ವಸ್ತು",te:"నమూనా వస్తువు"},
  rsnDamaged:{en:"Sticker damaged or missing",hi:"स्टिकर खराब या गायब",mr:"स्टिकर खराब किंवा गहाळ",kn:"ಸ್ಟಿಕರ್ ಹಾಳಾಗಿದೆ ಅಥವಾ ಇಲ್ಲ",te:"స్టిక్కర్ పాడైంది లేదా లేదు"},
  rsnLate:{en:"Added to the load late",hi:"बाद में गाड़ी में जोड़ा गया",mr:"नंतर गाडीत टाकले",kn:"ನಂತರ ಲೋಡ್‌ಗೆ ಸೇರಿಸಲಾಗಿದೆ",te:"తర్వాత లోడ్‌కు చేర్చారు"},
  rsnRepair:{en:"Going for repair",hi:"मरम्मत के लिए जा रहा है",mr:"दुरुस्तीसाठी जात आहे",kn:"ದುರಸ್ತಿಗೆ ಹೋಗುತ್ತಿದೆ",te:"మరమ్మతు కోసం వెళ్తోంది"},
  rsnOther:{en:"Something else",hi:"कुछ और",mr:"दुसरे काही",kn:"ಬೇರೆ ಏನೋ",te:"ఇంకేదో"},
  closeTrip:{en:"Close trip",hi:"ट्रिप बंद करें",mr:"ट्रिप बंद करा",kn:"ಟ್ರಿಪ್ ಮುಚ್ಚಿ",te:"ట్రిప్ మూసివేయండి"},
  direction:{en:"Direction",hi:"दिशा",mr:"दिशा",kn:"ದಿಕ್ಕು",te:"దిశ"},
  flagged:{en:"Flagged",hi:"निशान लगे",mr:"चिन्हांकित",kn:"ಗುರುತಾದವು",te:"గుర్తు పెట్టినవి"},
  timeTaken:{en:"Time taken",hi:"लगा समय",mr:"लागलेला वेळ",kn:"ತೆಗೆದುಕೊಂಡ ಸಮಯ",te:"పట్టిన సమయం"},
  back:{en:"Back",hi:"वापस",mr:"मागे",kn:"ಹಿಂದೆ",te:"వెనుకకు"},
  add:{en:"Add",hi:"जोड़ें",mr:"जोडा",kn:"ಸೇರಿಸಿ",te:"జోడించండి"},
  settings:{en:"Settings",hi:"सेटिंग",mr:"सेटिंग",kn:"ಸೆಟ್ಟಿಂಗ್ಸ್",te:"సెట్టింగ్‌లు"},
  nightMode:{en:"Night mode",hi:"रात मोड",mr:"रात्र मोड",kn:"ರಾತ್ರಿ ಮೋಡ್",te:"రాత్రి మోడ్"},
  language:{en:"Language",hi:"भाषा",mr:"भाषा",kn:"ಭಾಷೆ",te:"భాష"},
  waiting:{en:"saved here, not sent yet",hi:"भेजना बाकी",mr:"पाठवायचे बाकी",kn:"ಕಳುಹಿಸಲು ಬಾಕಿ",te:"పంపడానికి పెండింగ్"},
  allSent:{en:"All sent",hi:"सब भेज दिया",mr:"सर्व पाठवले",kn:"ಎಲ್ಲಾ ಕಳುಹಿಸಲಾಗಿದೆ",te:"అన్నీ పంపబడ్డాయి"},
  offline:{en:"No connection — saved on this phone",hi:"कनेक्शन नहीं — फोन में सेव है",mr:"कनेक्शन नाही — फोनमध्ये सेव्ह आहे",kn:"ಸಂಪರ್ಕ ಇಲ್ಲ — ಫೋನ್‌ನಲ್ಲಿ ಉಳಿಸಲಾಗಿದೆ",te:"కనెక్షన్ లేదు — ఫోన్‌లో సేవ్ అయింది"},
  syncNow:{en:"Send now",hi:"अभी भेजें",mr:"आता पाठवा",kn:"ಈಗ ಕಳುಹಿಸಿ",te:"ఇప్పుడే పంపండి"},
  needsAttention:{en:"Needs attention",hi:"ध्यान चाहिए",mr:"लक्ष द्या",kn:"ಗಮನ ಬೇಕು",te:"శ్రద్ధ కావాలి"},
  notPaired:{en:"This phone is not paired",hi:"यह फोन जोड़ा नहीं गया है",mr:"हा फोन जोडलेला नाही",kn:"ಈ ಫೋನ್ ಜೋಡಿಸಿಲ್ಲ",te:"ఈ ఫోన్ జత చేయబడలేదు"},
  askManager:{en:"Ask your manager for a pairing link.",hi:"मैनेजर से जोड़ने का लिंक मांगें।",mr:"मॅनेजरकडून जोडणीची लिंक मागा.",kn:"ಮ್ಯಾನೇಜರ್‌ರಿಂದ ಜೋಡಣೆ ಲಿಂಕ್ ಕೇಳಿ.",te:"మేనేజర్‌ను పెయిరింగ్ లింక్ అడగండి."},
  retry:{en:"Try again",hi:"फिर कोशिश करें",mr:"पुन्हा प्रयत्न करा",kn:"ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ",te:"మళ్లీ ప్రయత్నించండి"},
  cameraBlocked:{en:"Camera permission is needed to scan",hi:"स्कैन के लिए कैमरा की अनुमति चाहिए",mr:"स्कॅनसाठी कॅमेरा परवानगी हवी",kn:"ಸ್ಕ್ಯಾನ್‌ಗೆ ಕ್ಯಾಮೆರಾ ಅನುಮತಿ ಬೇಕು",te:"స్కాన్ కోసం కెమెరా అనుమతి కావాలి"},
  // WHY THREE MESSAGES AND NOT ONE. Every camera failure used to read
  // "Camera permission is needed", including the common one that has nothing
  // to do with permission: the camera is still held by the screen before.
  // Mahesh, 23 Sep 2026 21:26 — his previous trip had taken its vehicle photo
  // and three scans eleven minutes earlier, so permission was plainly granted;
  // the phone simply had not released the camera yet.
  cameraBusy:{en:"The camera is busy — close any other camera app and try again",hi:"कैमरा व्यस्त है — दूसरा कैमरा ऐप बंद करके फिर कोशिश करें",mr:"कॅमेरा व्यस्त आहे — दुसरे कॅमेरा अ‍ॅप बंद करून पुन्हा प्रयत्न करा",kn:"ಕ್ಯಾಮೆರಾ ಬಳಕೆಯಲ್ಲಿದೆ — ಬೇರೆ ಕ್ಯಾಮೆರಾ ಆ್ಯಪ್ ಮುಚ್ಚಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ",te:"కెమెరా బిజీగా ఉంది — వేరే కెమెరా యాప్ మూసి మళ్లీ ప్రయత్నించండి"},
  cameraNone:{en:"No camera found on this phone",hi:"इस फोन में कैमरा नहीं मिला",mr:"या फोनमध्ये कॅमेरा सापडला नाही",kn:"ಈ ಫೋನ್‌ನಲ್ಲಿ ಕ್ಯಾಮೆರಾ ಸಿಗಲಿಲ್ಲ",te:"ఈ ఫోన్‌లో కెమెరా కనబడలేదు"},
  cameraAllowHow:{en:"Tap the lock icon beside the web address, then Permissions, then Camera, then Allow.",hi:"वेब पते के पास ताले के निशान पर टैप करें, फिर Permissions, फिर Camera, फिर Allow चुनें।",mr:"वेब पत्त्याजवळील कुलूप चिन्हावर टॅप करा, नंतर Permissions, नंतर Camera, नंतर Allow निवडा.",kn:"ವೆಬ್ ವಿಳಾಸದ ಪಕ್ಕದ ಬೀಗದ ಚಿಹ್ನೆ ಒತ್ತಿ, ನಂತರ Permissions, ನಂತರ Camera, ನಂತರ Allow ಆಯ್ಕೆಮಾಡಿ.",te:"వెబ్ చిరునామా పక్కన ఉన్న తాళం గుర్తును నొక్కి, తర్వాత Permissions, తర్వాత Camera, తర్వాత Allow ఎంచుకోండి."},
};

export function makeT(lang: LangId) {
  return (key: string): string => STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? key;
}
