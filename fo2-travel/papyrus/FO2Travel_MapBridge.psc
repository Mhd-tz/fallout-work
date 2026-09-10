Scriptname FO2Travel_MapBridge extends Quest Conditional
{
  Game-side half of the Chryslus NAVCOM travel screen.

  There are two ways to talk to the view, and this script supports both:

    A. NO C++ REQUIRED (polling)
       The view writes its state into the TESGlobals below using
       window.prisma.setGlobal(). This script polls them on a timer and acts.
       Slower to react (POLL_INTERVAL) but needs no plugin of your own.

    B. WITH AN F4SE PLUGIN (event driven)
       Your plugin binds "sendDataToF4SE", parses the JSON, and calls the
       public functions at the bottom of this script. Instant, and it carries
       the full payload rather than just numbers.

  TravelMarkers MUST be filled in the Creation Kit in the SAME ORDER as
  WORLD.LOCATIONS in js/worldmap.js. The view sends the array index in
  FO2_DestIndex, and index 0 is Arroyo.

  NOTE: this file is a template. It has not been compiled against your load
  order - wire up the properties in the CK and adjust the encounter hand-off
  to however your mod actually spawns encounters.
}

;-------------------------------------------------------------------------
; PROPERTIES - all Auto so PrismaUI can read/write them via getProperty /
; setProperty without any C++ at all.
;-------------------------------------------------------------------------
GlobalVariable Property FO2_DestX          Auto  ; 801 - world X chosen in the UI
GlobalVariable Property FO2_DestZ          Auto  ; 802 - world Z
GlobalVariable Property FO2_DestIndex      Auto  ; 803 - index into TravelMarkers
GlobalVariable Property FO2_TravelMode     Auto  ; 804 - 0 idle, 1 fast travel, 2 manual drive
GlobalVariable Property FO2_Fuel           Auto  ; 805 - MFC charge, 0-100
GlobalVariable Property FO2_Condition      Auto  ; 806 - chassis condition, 0-100
GlobalVariable Property FO2_Encounter      Auto  ; 807 - non-zero while an encounter is pending
GlobalVariable Property GameDaysPassed     Auto  ; Fallout4.esm 0x00000039

ObjectReference[] Property TravelMarkers   Auto
{ Map markers / XMarkerHeadings, index-aligned with WORLD.LOCATIONS. }

Quest Property EncounterQuest              Auto
{ Quest that stages a random encounter. Optional. }

ObjectReference Property HighwaymanRef     Auto
{ The drivable car reference, if the mod has one placed. }

Message Property TravelBlockedMsg          Auto
{ Shown when travel is refused (over-encumbered, in combat, ...). }

Float  Property PollInterval = 0.5         Auto
Bool   Property DebugLogging = True        Auto

;-------------------------------------------------------------------------
; STATE
;-------------------------------------------------------------------------
Float  Property PendingHours   Auto Conditional
Float  Property PendingFuel    Auto Conditional
Int    Property LastMode       Auto Conditional
Int    Property LastEncounter  Auto Conditional
Bool   Property TravelLocked   Auto Conditional

;=========================================================================
; LIFECYCLE
;=========================================================================
Event OnQuestInit()
  LastMode = 0
  LastEncounter = 0
  RegisterForSingleUpdate(PollInterval)
  Log("NAVCOM bridge online")
EndEvent

Event OnUpdate()
  PollUI()
  RegisterForSingleUpdate(PollInterval)
EndEvent

;=========================================================================
; A. POLLING PATH - no plugin needed
;=========================================================================
Function PollUI()
  If !FO2_TravelMode
    Return
  EndIf

  Int mode = FO2_TravelMode.GetValueInt()
  If mode != LastMode
    If mode == 1
      OnTravelBegin(FO2_DestIndex.GetValueInt())
    ElseIf mode == 2
      OnDriveBegin()
    ElseIf mode == 0 && LastMode != 0
      OnTravelEnd()
    EndIf
    LastMode = mode
  EndIf

  If FO2_Encounter
    Int enc = FO2_Encounter.GetValueInt()
    If enc != 0 && LastEncounter == 0
      OnEncounterPending()
    EndIf
    LastEncounter = enc
  EndIf
EndFunction

;=========================================================================
; B. PLUGIN PATH - call these straight from your F4SE plugin after parsing
;    the JSON that "sendDataToF4SE" delivers.
;=========================================================================

; type "travel.begin" - the player committed to a route.
; Validate here; refuse by calling DenyTravel().
Function OnTravelBegin(Int destIndex)
  If IsTravelBlocked()
    DenyTravel("in combat")
    Return
  EndIf
  TravelLocked = True
  Log("travel begin -> index " + destIndex)
EndFunction

; type "travel.complete" - the view finished the drive animation.
; This is where the player is actually relocated and the clock moves.
Function OnTravelComplete(Int destIndex, Float hours, Float fuelUsed, Float condition)
  TravelLocked = False

  If destIndex < 0 || !TravelMarkers || destIndex >= TravelMarkers.Length
    Log("ERROR travel.complete with bad index " + destIndex)
    Return
  EndIf

  ObjectReference marker = TravelMarkers[destIndex]
  If !marker
    Log("ERROR no marker at index " + destIndex)
    Return
  EndIf

  AdvanceGameHours(hours)

  Actor player = Game.GetPlayer()
  player.MoveTo(marker)
  If HighwaymanRef
    HighwaymanRef.MoveTo(marker)
  EndIf

  If FO2_Fuel
    FO2_Fuel.SetValue(FO2_Fuel.GetValue() - fuelUsed)
  EndIf
  If FO2_Condition
    FO2_Condition.SetValue(condition)
  EndIf

  Log("arrived at index " + destIndex + " after " + hours + "h")
EndFunction

; type "encounter.trigger" then "encounter.resolve" with choice "fight".
; Hand off to whatever spawns your encounters, then hide the view.
Function OnEncounterPending()
  Log("encounter pending")
  If EncounterQuest && !EncounterQuest.IsRunning()
    EncounterQuest.Start()
  EndIf
EndFunction

; type "drive.begin" / "drive.end"
Function OnDriveBegin()
  Log("manual drive begin")
EndFunction

Function OnTravelEnd()
  TravelLocked = False
  Log("travel/drive ended")
EndFunction

;=========================================================================
; HELPERS
;=========================================================================

; Advancing the clock: setting GameHour past 24 does not roll the date over,
; so move GameDaysPassed instead - that is the value the engine derives the
; whole calendar from.
Function AdvanceGameHours(Float hours)
  If !GameDaysPassed || hours <= 0.0
    Return
  EndIf
  GameDaysPassed.SetValue(GameDaysPassed.GetValue() + (hours / 24.0))
EndFunction

Bool Function IsTravelBlocked()
  Actor player = Game.GetPlayer()
  If player.IsInCombat()
    Return True
  EndIf
  If player.GetSitState() != 0
    Return True
  EndIf
  Return False
EndFunction

Function DenyTravel(String reason)
  TravelLocked = False
  If FO2_TravelMode
    FO2_TravelMode.SetValue(0)
  EndIf
  If TravelBlockedMsg
    TravelBlockedMsg.Show()
  EndIf
  Log("travel denied: " + reason)
EndFunction

Function Log(String msg)
  If DebugLogging
    Debug.Trace("[FO2Travel] " + msg)
  EndIf
EndFunction
