// Built-in sensitive list. A tab is sent as "private" (site only, no title or path) when its host is
// one of these domains or a subdomain of one, when its host contains one of the host stems, or when a
// keyword matches as a whole word or phrase in the host, the full path or the title (see payload.js).
// The user can edit the list in Settings; "reset" restores these values, so they are frozen here and
// callers copy before editing. store.js keeps only the user's edits (entries added, defaults removed)
// and merges them with these lists on every read, so an entry added here reaches everyone, including
// people who saved their settings before it existed.
//
// Domains: an entry matches the host itself and every subdomain, so "gov" covers every *.gov host.
// Keep entries narrow (mail.google.com, not google.com) to keep false positives low.
// Keywords: matched case- and accent-insensitively as whole words, so "bank" never matches
// "embankment" and "ira" never matches "pirate". Punctuation counts as a word break: "w-2" also
// matches "W 2", and "401(k)" matches "401 k". Words that also name ordinary things ("rehab" for a
// house, "addiction" in a baking blog's name) are listed only inside a phrase. Search result pages
// carry the query in their title, so phrases people type ("am i pregnant") belong here too.
// Host stems: matched anywhere inside the host name, never in the title or path, so a payment portal
// whose host is one long token ("countysecurepaymentgateway.com") is still caught. Hyphens in the host
// are ignored ("bill-pay" holds "billpay"). Only stems that mean nothing else belong here.

const DOMAINS = [
  // Banks
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "usbank.com", "pnc.com",
  "capitalone.com", "tdbank.com", "td.com", "truist.com", "ally.com", "discover.com",
  "americanexpress.com", "usaa.com", "navyfederal.org", "sofi.com", "chime.com",
  "citizensbank.com", "hsbc.com", "hsbc.co.uk", "barclays.co.uk", "lloydsbank.com", "natwest.com",
  "santander.co.uk", "monzo.com", "revolut.com", "n26.com", "boursobank.com",
  "labanquepostale.fr", "credit-agricole.fr", "sg.fr", "lcl.fr", "caisse-epargne.fr",
  "creditmutuel.fr", "mabanque.bnpparibas", "rbcroyalbank.com", "scotiabank.com", "cibc.com",
  "bmo.com", "attijariwafabank.com",
  // Brokers, investing and crypto
  "fidelity.com", "vanguard.com", "schwab.com", "etrade.com", "robinhood.com",
  "interactivebrokers.com", "merrilledge.com", "wealthfront.com", "betterment.com", "degiro.com",
  "trading212.com", "etoro.com", "coinbase.com", "kraken.com", "binance.com",
  // Retirement, payroll and benefits
  "principal.com", "empower.com", "tiaa.org", "troweprice.com", "voya.com", "ameriprise.com",
  "edwardjones.com", "adp.com", "paychex.com", "gusto.com", "myworkday.com",
  // Payments, money transfer and credit
  "paypal.com", "venmo.com", "cash.app", "wise.com", "klarna.com", "affirm.com", "zelle.com",
  "westernunion.com", "moneygram.com", "remitly.com", "pay.amazon.com",
  "dashboard.stripe.com", "checkout.stripe.com", "billing.stripe.com", "invoice.stripe.com",
  "buy.stripe.com", "pay.google.com", "creditkarma.com", "experian.com", "equifax.com",
  "transunion.com", "annualcreditreport.com",
  // Loans, student-loan servicers, consumer credit, debt relief, debt collectors and bankruptcy help
  "rocketmortgage.com", "lendingclub.com", "lendingtree.com", "prosper.com", "upstart.com",
  "avant.com", "oportun.com", "earnin.com", "navient.com", "nelnet.com", "mohela.com",
  "aidvantage.com", "nationaldebtrelief.com", "freedomdebtrelief.com", "upsolve.org",
  "portfoliorecovery.com", "midlandcredit.com", "cetelem.fr", "cofidis.fr", "sofinco.fr",
  "younited-credit.com",
  // Bill-pay and county or municipal payment portals (hosts with "payment" in them are host stems)
  "invoicecloud.com", "govpaynow.com", "govpaynet.com", "doxo.com", "speedpay.com", "bill.com",
  "billmatrix.com", "papergov.com",
  // Tax
  "turbotax.intuit.com", "hrblock.com",
  // Health portals, telehealth, pharmacy benefits and insurers
  "mychart.com", "kp.org", "kaiserpermanente.org", "zocdoc.com", "labcorp.com",
  "questdiagnostics.com", "followmyhealth.com", "athenahealth.com", "healow.com", "onemedical.com",
  "teladoc.com", "mdlive.com", "amwell.com", "doctorondemand.com", "healthgrades.com",
  "doctor.webmd.com", "goodrx.com", "express-scripts.com", "optumrx.com", "caremark.com",
  "hims.com", "forhers.com", "ro.co", "nurx.com", "plannedparenthood.org", "23andme.com",
  "anthem.com", "aetna.com", "cigna.com", "uhc.com", "myuhc.com", "bcbs.com", "humana.com",
  "hioscar.com", "geico.com", "progressive.com", "statefarm.com", "allstate.com",
  "libertymutual.com", "nhs.uk", "doctolib.fr", "ameli.fr",
  // Reproductive and sexual health: abortion access, cycle and fertility tracking, home STI tests
  "abortionfinder.org", "aidaccess.org", "ineedana.com", "flo.health", "helloclue.com",
  "progyny.com", "kindbody.com", "everlywell.com", "letsgetchecked.com", "stdcheck.com",
  // Mental health: therapy platforms and therapist directories
  "betterhelp.com", "talkspace.com", "psychologytoday.com", "growtherapy.com", "headway.co",
  "helloalma.com", "sondermind.com", "cerebral.com", "lyrahealth.com", "goodtherapy.org",
  // Crisis lines and support groups: suicide, LGBTQ and trans crisis lines, eating disorders, mental
  // illness, addiction, domestic and sexual abuse
  "988lifeline.org", "suicidepreventionlifeline.org", "crisistextline.org", "samaritans.org",
  "thetrevorproject.org", "translifeline.org", "nationaleatingdisorders.org", "anad.org",
  "beateatingdisorders.org.uk", "nami.org", "aa.org", "na.org", "smartrecovery.org", "thehotline.org",
  "loveisrespect.org", "rainn.org", "womensaid.org.uk", "refuge.org.uk",
  // Dating
  "tinder.com", "bumble.com", "hinge.co", "match.com", "okcupid.com", "grindr.com", "feeld.co",
  "pof.com", "plentyoffish.com", "eharmony.com", "zoosk.com", "coffeemeetsbagel.com", "happn.com",
  "meetic.fr",
  // Adult
  "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com", "youporn.com",
  "onlyfans.com", "fansly.com", "chaturbate.com", "stripchat.com",
  // Gambling: sportsbooks, casinos, poker, self-exclusion services and problem-gambling help
  "draftkings.com", "fanduel.com", "betmgm.com", "bet365.com", "pokerstars.com", "williamhill.com",
  "paddypower.com", "betfair.com", "ladbrokes.com", "skybet.com", "betway.com", "unibet.com",
  "stake.com", "888casino.com", "bovada.lv", "winamax.fr", "betclic.fr", "unibet.fr", "pmu.fr",
  "begambleaware.org", "gamstop.co.uk", "gamblersanonymous.org", "ncpgambling.org",
  // Webmail
  "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
  "mail.yahoo.com", "proton.me", "protonmail.com", "mail.aol.com", "icloud.com", "fastmail.com",
  "tuta.com", "mail.zoho.com", "gmx.com", "gmx.net",
  // Government (whole suffixes: "gov" is every *.gov host)
  "gov", "mil", "gov.uk", "gouv.fr", "service-public.fr", "gc.ca", "canada.ca", "gov.ma",
];

const KEYWORDS = [
  // Banking and credit
  "bank", "banking", "account statement", "account number", "routing number", "wire transfer",
  "credit report", "mortgage",
  // Loans, debt and bankruptcy. "loan" alone also names a library loan, and "bankruptcy" alone fills
  // business news and law courses, so both are listed only inside a phrase.
  "credit card application", "credit card applications", "credit application",
  "apply for a credit card", "loan application", "loan applications", "apply for a loan",
  "loan approval", "personal loan", "personal loans", "payday loan", "payday loans", "home loan",
  "home loans", "car loan", "auto loan", "student loan", "student loans", "credit score",
  "credit limit", "credit card debt", "debt consolidation", "debt relief", "debt settlement",
  "debt collection", "debt collector", "debt collectors", "collection agency", "collections agency",
  "file for bankruptcy", "filing for bankruptcy", "declare bankruptcy", "declaring bankruptcy",
  "personal bankruptcy", "bankruptcy attorney", "bankruptcy attorneys", "bankruptcy lawyer",
  "bankruptcy lawyers", "chapter 7 bankruptcy", "chapter 13 bankruptcy",
  // Payments and bills
  "payment", "payments", "checkout", "billing", "invoice", "invoices", "bill pay", "pay bill",
  // Retirement and investing
  "retirement", "pension", "annuity", "401k", "401(k)", "403b", "403(b)", "ira", "brokerage",
  // Health, pharmacy and insurance
  "insurance", "explanation of benefits", "patient", "diagnosis", "prescription", "prescriptions",
  "pharmacy", "lab results", "medical record", "medical records", "health record", "mychart",
  "std test", "std testing", "sti test", "sti testing", "hiv test", "hiv testing",
  "pregnancy test", "fertility clinic", "ivf",
  // Serious illness. "cancer" alone is also a star sign and a constellation, and "diabetes" alone fills
  // recipe and nutrition pages, so both are listed only inside phrases.
  "cancer treatment", "cancer treatments", "cancer care", "cancer center", "cancer centre",
  "cancer support", "chemotherapy", "radiotherapy", "oncology", "oncologist", "oncologists",
  "diabetes management", "managing diabetes", "insulin pump",
  // Sexual and reproductive health. "abortion" and "hiv" stand alone: any page about them is health
  // data. "pregnancy" and "miscarriage" alone also fill news ("teen pregnancy rates", "miscarriage of
  // justice"), so they are listed inside phrases.
  "hiv", "antiretroviral", "std symptoms", "sti symptoms", "std clinic", "sexual health", "herpes",
  "chlamydia", "gonorrhea", "gonorrhoea", "syphilis", "hpv", "genital warts",
  "abortion", "mifepristone", "misoprostol", "birth control", "contraception", "contraceptive",
  "contraceptives", "morning-after pill", "emergency contraception", "iud", "vasectomy",
  "tubal ligation", "pregnancy symptoms", "early pregnancy", "pregnancy week by week",
  "weeks pregnant", "am i pregnant", "getting pregnant", "trying to conceive", "ectopic pregnancy",
  "pregnancy loss", "miscarriage symptoms", "signs of miscarriage", "due date calculator",
  "prenatal", "ovulation", "obgyn", "ob-gyn", "gynecologist", "gynaecologist", "gynecology",
  "gynaecology", "infertility", "fertility treatment", "fertility treatments", "fertility test",
  "fertility testing", "egg freezing", "sperm donor", "egg donor", "sperm count", "surrogacy",
  // Sexual orientation and gender identity. "gender" alone fills grammar and code pages, and "coming
  // out" alone fills release and economic news ("coming out this fall"), so those are phrases.
  "transgender", "gender transition", "gender-affirming", "gender dysphoria", "coming out as gay",
  "coming out as lesbian", "coming out as bisexual", "coming out as trans", "coming out to my parents",
  "coming out to parents", "am i gay", "am i lesbian", "am i bisexual", "am i trans", "lgbtq health",
  "lgbt health", "lgbtq support", "lgbtq helpline",
  // Mental health, therapy and addiction. "AA" alone is a battery size and "sober" a design word, so
  // both are listed only inside phrases.
  "mental health", "psychiatrist", "psychiatrists", "psychiatric", "psychiatry", "psychologist",
  "psychologists", "psychotherapy", "psychotherapist", "therapist", "therapists", "therapy",
  "counseling", "counselling", "counselor", "counsellor", "rehab center", "rehab centers",
  "drug rehab", "alcohol rehab", "addiction treatment", "addiction recovery", "drug addiction",
  "alcohol addiction", "substance abuse", "alcoholics anonymous", "narcotics anonymous",
  "gamblers anonymous", "suboxone", "methadone", "naltrexone", "buprenorphine", "alcoholism",
  "alcohol use disorder", "alcohol withdrawal", "opioid withdrawal", "opioid treatment",
  "opioid use disorder", "aa meeting", "aa meetings", "sober living",
  // Mental health conditions, crisis and psychiatric medicines. "depression" and "anxiety" alone also
  // name the Great Depression, a tropical depression and market anxiety, and "suicide" alone names a
  // film, a song and a rocket manoeuvre, so those are listed inside phrases.
  "anxiety disorder", "anxiety disorders", "anxiety attack", "anxiety attacks", "anxiety symptoms",
  "anxiety treatment", "anxiety medication", "social anxiety", "generalized anxiety",
  "health anxiety", "panic attack", "panic attacks", "panic disorder", "gad-7",
  "depression symptoms", "depression treatment", "depression test", "signs of depression",
  "clinical depression", "major depression", "major depressive disorder", "depressive disorder",
  "postpartum depression", "postnatal depression", "treatment-resistant depression",
  "am i depressed", "phq-9", "bipolar disorder", "ptsd", "schizophrenia", "personality disorder",
  "obsessive compulsive disorder", "adhd", "attention deficit", "eating disorder",
  "eating disorders", "anorexia", "anorexic", "bulimia", "bulimic", "binge eating", "arfid",
  "suicidal", "suicide prevention", "suicide hotline", "suicide helpline", "suicide lifeline",
  "suicide crisis", "suicide attempt", "suicide attempts", "crisis line", "crisis text line",
  "crisis hotline", "self-harm", "self-harming", "self-injury", "kill myself", "end my life",
  "antidepressant", "antidepressants", "ssri", "ssris", "sertraline", "fluoxetine", "escitalopram",
  "citalopram", "bupropion", "venlafaxine", "zoloft", "prozac", "lexapro", "wellbutrin", "effexor",
  "adderall", "ritalin", "vyvanse", "methylphenidate", "xanax", "alprazolam", "klonopin",
  "clonazepam", "benzodiazepine", "benzodiazepines",
  // Immigration. "visa" alone is also a card brand, and "asylum" a game and horror setting.
  "immigration lawyer", "immigration attorney", "immigration status", "immigration application",
  "immigration court", "immigration case", "immigration hearing", "deportation defense",
  "deportation lawyer", "removal proceedings", "uscis", "daca", "h1b", "h-1b",
  "green card application", "green card renewal", "green card interview", "green card holder",
  "green card lottery", "visa application", "visa appointment", "visa interview", "visa status",
  "visa sponsorship", "visa renewal", "work visa", "student visa", "work permit", "residence permit",
  "permanent residency", "permanent resident", "naturalization", "citizenship application",
  "asylum application", "asylum seeker", "asylum seekers", "asylum claim", "asylum case",
  "asylum interview", "political asylum", "apply for asylum", "refugee status",
  // Gambling. "casino" and "betting" alone also name films and everyday talk.
  "gambling addiction", "problem gambling", "gambling problem", "compulsive gambling",
  "gambling help", "online casino", "sportsbook", "sports betting", "gamstop",
  // Legal: family, criminal defence, domestic and sexual abuse
  "divorce", "child custody", "restraining order", "protective order", "order of protection",
  "criminal record", "expungement", "criminal defense", "criminal defence", "criminal lawyer",
  "criminal attorney", "dui lawyer", "dui attorney", "dwi lawyer", "dwi attorney",
  "public defender", "bail bonds", "bail bondsman", "arrest record", "domestic violence",
  "domestic abuse", "intimate partner violence", "abusive relationship", "abusive partner",
  "sexual assault", "sexual abuse", "rape crisis", "women's shelter",
  // Adult
  "porn", "nsfw", "xxx", "hentai", "onlyfans",
  // Tax, payroll and identity
  "tax return", "tax returns", "tax refund", "w-2", "form 1099", "payslip", "payslips",
  "pay stub", "paystub", "payroll", "ssn", "social security number", "passport",
  // French equivalents (accents are ignored when matching)
  "banque", "paiement", "paiements", "facturation", "retraite", "facture", "factures",
  "fiche de paie", "bulletin de salaire", "impots", "avis d'imposition", "passeport",
  "securite sociale", "mutuelle", "pharmacie", "ordonnance", "sante mentale", "psychiatre",
  "psychologue", "psychotherapeute", "therapie",
  // French: health, mental health, serious illness, gender identity and addiction ("enceinte" alone is
  // also a loudspeaker, so it is a phrase)
  "trouble anxieux", "troubles anxieux", "crise d'angoisse", "attaque de panique",
  "symptomes de la depression", "trouble depressif", "troubles depressifs", "antidepresseur",
  "antidepresseurs", "trouble bipolaire", "tdah", "anorexie", "boulimie", "trouble alimentaire",
  "troubles alimentaires", "troubles du comportement alimentaire", "idees suicidaires",
  "pensees suicidaires", "automutilation", "vih", "avortement", "chimiotherapie", "radiotherapie",
  "oncologie", "oncologue", "traitement du cancer", "transgenre", "transgenres", "dysphorie de genre",
  "transition de genre", "alcoolisme", "alcooliques anonymes", "sevrage alcoolique",
  "interruption volontaire de grossesse", "pilule du lendemain", "contraceptif", "sterilet",
  "test de grossesse", "symptomes de grossesse", "debut de grossesse", "suis-je enceinte",
  "gynecologue", "infertilite", "procreation medicalement assistee",
  // French: immigration, credit and debt, legal, gambling ("pret" alone is also "ready")
  "titre de sejour", "carte de sejour", "demande d'asile", "droit d'asile", "naturalisation",
  "visa long sejour", "pret immobilier", "credit immobilier", "demande de pret", "pret personnel",
  "credit a la consommation", "rachat de credit", "rachat de credits", "surendettement",
  "faillite personnelle", "interdit bancaire", "recouvrement de creances",
  "societe de recouvrement", "huissier", "casier judiciaire", "avocat penal",
  "violences conjugales", "violence conjugale", "violences sexuelles", "paris sportifs",
  "casino en ligne", "addiction aux jeux",
];

// Substrings of a host name. Each one only ever appears in payment, patient-portal or gambling hosts
// ("gambl": gambling, gambler, gamble). The surname Gamble and the paint maker Gamblin are accepted false
// positives.
const HOST_STEMS = [
  "payment", "billpay", "paybill", "paygov", "paynow", "checkout", "patientportal", "bcbs", "gambl",
];

export const DEFAULT_SENSITIVE = Object.freeze({
  domains: Object.freeze(DOMAINS),
  keywords: Object.freeze(KEYWORDS),
  hostStems: Object.freeze(HOST_STEMS),
});
