+================================================================
+ Cabinet CAM - FluidNC / Grbl (inch)
+ A Vectric-format post. Edit it here, or copy it under a new name
+ (and change POST_NAME) for another machine.
+
+ The first bit is already in the machine: the HEADER has no stop.
+ Later bits stop with M0 (load the bit, zero Z, cycle start).
+ Cabinet CAM extras (Vectric won't load this file back):
+   begin OPERATOR_STOP  - screw hold-downs: stop for the operator
+   [MESSAGE]            - the stop's message
+   [SPINUP]             - spin-up seconds (Cutting settings)
+================================================================
POST_NAME = "FluidNC - Cabinet CAM (inch)(*.nc)"
FILE_EXTENSION = "nc"
UNITS = "INCHES"

VAR SPINDLE_SPEED = [S|A|S|1.0]
VAR FEED_RATE = [F|C|F|1.1]
VAR X_POSITION = [X|A|X|1.4]
VAR Y_POSITION = [Y|A|Y|1.4]
VAR Z_POSITION = [Z|A|Z|1.4]
VAR ARC_CENTRE_I_INC_POSITION = [I|A|I|1.4]
VAR ARC_CENTRE_J_INC_POSITION = [J|A|J|1.4]
VAR SAFE_Z_HEIGHT = [SAFEZ|A|Z|1.4]
VAR X_HOME_POSITION = [XH|A|X|1.4]
VAR Y_HOME_POSITION = [YH|A|Y|1.4]
VAR Z_LENGTH = [ZLENGTH|A||1.4]

begin HEADER
"([FILENAME])"
"(Material [MATERIAL] [ZLENGTH]in - Z0 = [Z_ORIGIN])"
"G20 G90 G17 G94"
"G0 [SAFEZ]"
"(Bit: [TOOLNAME] - already loaded)"
"M3 [S]"
"G4 P[SPINUP]"

begin NEW_SEGMENT
"([TOOLPATH_NAME])"

begin TOOLCHANGE
"M5"
"G0 [SAFEZ]"
"(Load [TOOLNAME], zero Z, then cycle start)"
"M0"
"M3 [S]"
"G4 P[SPINUP]"

begin OPERATOR_STOP
"M5"
"G0 [SAFEZ]"
"([MESSAGE])"
"M0"
"M3 [S]"
"G4 P[SPINUP]"

begin RAPID_MOVE
"G0 [X] [Y] [Z]"

begin FEED_MOVE
"G1 [X] [Y] [Z] [F]"

begin CW_ARC_MOVE
"G2 [X] [Y] [Z] [I] [J] [F]"

begin CCW_ARC_MOVE
"G3 [X] [Y] [Z] [I] [J] [F]"

begin FOOTER
"G0 [SAFEZ]"
"M5"
"G0 [XH] [YH]"
"M30"
