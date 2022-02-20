sleep 2
webservice --mem 1Gi --backend=kubernetes node10 stop
sleep 15
webservice --mem 1Gi --backend=kubernetes node10 start
